require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// ===============================
// 🔥 VALIDACIÓN DE API KEY
// ===============================
if (!process.env.GROQ_API_KEY) {
    console.error("❌ ERROR: No se encontró GROQ_API_KEY en el .env");
    process.exit(1);
}

console.log("🔑 GROQ_API_KEY cargada:", process.env.GROQ_API_KEY.slice(0, 8) + "...");

// ===============================
// 🔥 INICIALIZACIÓN GROQ
// ===============================
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

// ===============================
const sesiones = new Map();

// ===============================
// 🔹 WHATSAPP (ULTRAMSG)
// ===============================
async function enviarWhatsAppUltramsg(numero, mensaje) {
    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;

    if (!instanceId || !token) {
        console.log("⚠️ Simulando WhatsApp a", numero);
        return;
    }

    const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
    const numeroLimpio = numero.replace(/\D/g, '');

    const params = new URLSearchParams();
    params.append("token", token);
    params.append("to", numeroLimpio);
    params.append("body", mensaje);

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });
        console.log(`✅ WhatsApp enviado a ${numeroLimpio}`);
    } catch (error) {
        console.error("❌ Error WhatsApp:", error);
    }
}

// ===============================
// 🔹 CORREO
// ===============================
async function enviarCorreoConfirmacion(correoDestino, asunto, texto) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("⚠️ Simulando correo a", correoDestino);
        return;
    }

    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: `"AutoRent" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: asunto,
            text: texto
        });
        console.log(`📧 Correo enviado a ${correoDestino}`);
    } catch (error) {
        console.error("❌ Error correo:", error);
    }
}

// ===============================
// 🔹 BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();

        return data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Vehiculo: `${a.Marca} ${a.Modelo}`,
                Precio: a.Precio_Por_Dia,
                Puertas: a.Puertas || "4",
                Asientos: a.Asientos || "5",
                Transmision: a.Transmision || "Automatica",
                Imagen: a.Imagen || ""
            }));
    } catch (error) {
        console.error("❌ Error autos:", error);
        return [];
    }
}

async function guardarReserva(datos) {
    try {
        await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [datos] })
        });
        console.log("✅ Reserva guardada");
    } catch (error) {
        console.error("❌ Error guardando:", error);
    }
}

async function cancelarReserva(folio) {
    try {
        await fetch(`${sheetdbUrl}/Folio/${folio}?sheet=Reservas`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { Estado: "Cancelado" } })
        });
        console.log("🚫 Reserva cancelada");
    } catch (error) {
        console.error("❌ Error cancelando:", error);
    }
}

// ===============================
// 🚀 WEBHOOK
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;

    console.log(`\n[Usuario] -> ${queryText}`);

    const autos = await obtenerAutos();

    const promptSistema = `
Eres un asistente de renta de autos.

Autos disponibles:
${JSON.stringify(autos)}

Responde SIEMPRE en JSON:
{
 "respuesta_usuario": "",
 "accion": "hablar",
 "autos_recomendados": [],
 "datos_cliente": { "Nombre": "", "Telefono": "", "Correo": "" },
 "datos_reserva": { "Modelo": "", "Fecha_inicio": "", "Fecha_fin": "", "Extras": "", "Folio": "" }
}
`;

    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }

    const historial = sesiones.get(sessionId);
    historial[0].content = promptSistema;
    historial.push({ role: "user", content: queryText });

    try {
        console.log("📩 Enviando a Groq...");

        const respuesta = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        console.log("📥 Respuesta recibida");

        let contenido = respuesta.choices[0].message.content;

        contenido = contenido.replace(/```json/g, '').replace(/```/g, '').trim();
        const json = JSON.parse(contenido);

        historial.push({ role: "assistant", content: JSON.stringify(json) });

        if (json.accion === "guardar_reserva") {
            await guardarReserva(json.datos_reserva);
        }

        if (json.accion === "cancelar_reserva") {
            await cancelarReserva(json.datos_reserva.Folio);
        }

        res.json({
            fulfillmentText: json.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ ERROR:", error.message || error);
        res.json({
            fulfillmentText: "Error técnico, intenta de nuevo"
        });
    }
});

// ===============================
app.listen(port, () => {
    console.log("🚀 Servidor corriendo en puerto", port);
});
