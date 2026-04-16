require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sesiones = new Map();

// ===============================
// 🔹 API DE WHATSAPP (WHAPI.CLOUD)
// ===============================
async function enviarWhatsAppWhapi(numero, mensaje) {
    const token = process.env.WHAPI_TOKEN;
    if (!token) return console.log("⚠️ Sin Token Whapi");

    const url = 'https://gate.whapi.cloud/messages/text';
    const numeroLimpio = numero.replace(/\D/g, ''); 
    const chatId = `${numeroLimpio}@s.whatsapp.net`;

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ to: chatId, body: mensaje })
        });
        console.log(`✅ WhatsApp enviado a ${numeroLimpio}`);
    } catch (error) {
        console.error("❌ Error Whapi:", error);
    }
}

// ===============================
// 🔹 API DE CORREO (NODEMAILER)
// ===============================
async function enviarCorreo(destinatario, asunto, texto) {
    if (!process.env.SMTP_USER) return;

    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: 587,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS // Contraseña de aplicación
        }
    });

    try {
        await transporter.sendMail({
            from: `"AutoRent Confirmaciones" <${process.env.SMTP_USER}>`,
            to: destinatario,
            subject: asunto,
            text: texto
        });
        console.log(`📧 Correo enviado a ${destinatario}`);
    } catch (error) {
        console.error("❌ Error Correo:", error);
    }
}

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        return data.filter(a => a.Disponibilidad === 'Disponible').map(a => ({
            Vehiculo: `${a.Marca} ${a.Modelo}`,
            Precio: a.Precio_Por_Dia,
            Puertas: a.Puertas,
            Asientos: a.Asientos,
            Transmision: a.Transmision,
            Imagen: a.Imagen
        }));
    } catch (error) {
        return [];
    }
}

async function guardarReserva(datos) {
    await fetch(`${sheetdbUrl}?sheet=Reservas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [datos] })
    });
}

async function cancelarReserva(folio) {
    await fetch(`${sheetdbUrl}/Folio/${folio}?sheet=Reservas`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { Estado: "Cancelado" } }) 
    });
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    const autos = await obtenerAutos();

    const promptSistema = `
    Eres AutoRent AI. Sigue este flujo ESTRICTO:
    1. BLOQUEO DE INICIO: Pide Nombre, Correo y WhatsApp. No hables de autos hasta tener los 3.
    2. PREFERENCIAS: Pregunta cuántas puertas, asientos y si prefiere Manual o Automático.
    3. CATÁLOGO: Filtra el inventario: ${JSON.stringify(autos)}.
       - Muestra solo los que encajen.
       - OBLIGATORIO: Incluye el link de la imagen del auto para que Telegram la muestre.
    4. CANCELLACIÓN: Si piden cancelar, pide Folio y confirma el éxito.
    5. CIERRE: Al confirmar reserva, genera un Folio dinámico (ej: RES-77X), pide confirmación final y avisa que se envió el correo/WhatsApp.

    RESPONDE SIEMPRE EN ESTE JSON:
    {
        "respuesta_usuario": "Tu mensaje aquí",
        "accion": "hablar" | "guardar_reserva" | "cancelar_reserva",
        "datos_cliente": {"Nombre": "", "Telefono": "", "Correo": ""},
        "datos_reserva": {"Modelo": "", "Folio": "", "Fecha_inicio": "", "Fecha_fin": ""}
    }`;

    if (!sesiones.has(sessionId)) sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    const historial = sesiones.get(sessionId);
    historial.push({ role: "user", content: queryText });

    try {
        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" }
        });

        const iaJSON = JSON.parse(completion.choices[0].message.content);
        historial.push({ role: "assistant", content: JSON.stringify(iaJSON) });

        if (iaJSON.accion === "guardar_reserva") {
            const d = iaJSON.datos_reserva;
            const c = iaJSON.datos_cliente;
            await guardarReserva({ ...c, ...d, Estado: "Confirmado" });
            
            const msg = `¡Hola ${c.Nombre}! Tu reserva ${d.Modelo} con folio ${d.Folio} está lista.`;
            await enviarWhatsAppWhapi(c.Telefono, msg);
            await enviarCorreo(c.Correo, "Confirmación de Reserva", msg);
        }

        if (iaJSON.accion === "cancelar_reserva") {
            await cancelarReserva(iaJSON.datos_reserva.Folio);
            await enviarWhatsAppWhapi(iaJSON.datos_cliente.Telefono, "Su reserva ha sido cancelada exitosamente.");
        }

        return res.json({ fulfillmentText: iaJSON.respuesta_usuario });
    } catch (e) {
        return res.json({ fulfillmentText: "Error de conexión, intenta de nuevo." });
    }
});

app.listen(port, () => console.log(`🚀 Puerto ${port}`));
