require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// URL base para el catálogo (Cámbiala cuando tengas tu dominio final)
const CATALOGO_URL = "https://tu-catalogo-autos.com/buscar";

// ===============================
// 🔥 VALIDACIÓN Y LIMPIEZA DE API KEY
// ===============================
const RAW_KEY = process.env.GROQ_API_KEY || "";
const CLEAN_KEY = RAW_KEY.trim(); 

if (!CLEAN_KEY) {
    console.error("❌ ERROR: No se encontró GROQ_API_KEY en las variables de entorno.");
} else {
    console.log(`🔑 Groq Key cargada correctamente. Longitud: ${CLEAN_KEY.length} caracteres.`);
}

const groq = new Groq({ apiKey: CLEAN_KEY });
const sesiones = new Map();

// ===============================
// 🔹 WHATSAPP (ULTRAMSG)
// ===============================
async function enviarWhatsAppUltramsg(numero, mensaje) {
    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;

    if (!instanceId || !token) return;

    const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
    const params = new URLSearchParams();
    params.append("token", token);
    params.append("to", numero.replace(/\D/g, ''));
    params.append("body", mensaje);

    try {
        await fetch(url, { method: 'POST', body: params });
        console.log(`✅ WhatsApp enviado a ${numero}`);
    } catch (error) {
        console.error("❌ Error WhatsApp:", error);
    }
}

// ===============================
// 🔹 CORREO (NODEMAILER)
// ===============================
async function enviarCorreoConfirmacion(correoDestino, asunto, texto) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

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
// 🔹 BASE DE DATOS (SHEETDB)
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
                Tipo: a.Tipo || "Sedan",
                Transmision: a.Transmision || "Automatica"
            }));
    } catch (error) {
        console.error("❌ Error obteniendo autos:", error);
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
        console.log("✅ Reserva guardada en SheetDB");
    } catch (error) {
        console.error("❌ Error guardando reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;

    // Obtenemos los autos de la base de datos
    const autos = await obtenerAutos();

    const promptSistema = `
Eres un asistente de renta de autos. Tu objetivo es ayudar al usuario a elegir un auto.
Para ahorrar memoria, NO envíes imágenes. Envía un LINK dinámico con las preferencias.

Autos disponibles:
${JSON.stringify(autos)}

Instrucciones:
1. Si el usuario muestra interés en un tipo de auto, construye un link usando: ${CATALOGO_URL}?tipo=VALOR&marca=VALOR
2. Responde SIEMPRE en formato JSON estricto:
{
 "respuesta_usuario": "Texto para el cliente incluyendo el link",
 "accion": "hablar | guardar_reserva | cancelar_reserva",
 "datos_cliente": { "Nombre": "", "Telefono": "", "Correo": "" },
 "datos_reserva": { "Modelo": "", "Fecha_inicio": "", "Fecha_fin": "", "Folio": "" }
}
`;

    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }

    const historial = sesiones.get(sessionId);
    historial[0].content = promptSistema; // Actualizar lista de autos en cada turno
    historial.push({ role: "user", content: queryText });

    try {
        const respuesta = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        const json = JSON.parse(respuesta.choices[0].message.content.trim());
        historial.push({ role: "assistant", content: JSON.stringify(json) });

        // Ejecutar acciones según la respuesta de la IA
        if (json.accion === "guardar_reserva") {
            await guardarReserva(json.datos_reserva);
            await enviarWhatsAppUltramsg(json.datos_cliente.Telefono, `¡Hola ${json.datos_cliente.Nombre}! Tu reserva del ${json.datos_reserva.Modelo} ha sido confirmada.`);
        }

        // Respuesta final a Dialogflow
        res.json({
            fulfillmentMessages: [
                {
                    text: {
                        text: [json.respuesta_usuario]
                    }
                }
            ]
        });

    } catch (error) {
        console.error("❌ ERROR EN EL WEBHOOK:", error);
        res.json({
            fulfillmentText: "Hubo un problema al procesar tu solicitud, por favor intenta de nuevo."
        });
    }
});

// ===============================
app.listen(port, () => {
    console.log(`🚀 Servidor AutoRent corriendo en puerto ${port}`);
});
