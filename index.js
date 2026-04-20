require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
// URL base de tu catálogo (puedes cambiarla por la real cuando esté lista)
const CATALOGO_URL = "https://tu-catalogo-autos.com/buscar";

// ===============================
// 🔥 VALIDACIÓN DE API KEY
// ===============================
if (!process.env.GROQ_API_KEY) {
    console.error("❌ ERROR: No se encontró GROQ_API_KEY en el .env");
    process.exit(1);
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const sesiones = new Map();

// ===============================
// 🔹 WHATSAPP & CORREO (Sin cambios significativos)
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
    try { await fetch(url, { method: 'POST', body: params }); } catch (e) { console.error(e); }
}

async function enviarCorreoConfirmacion(correoDestino, asunto, texto) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: process.env.SMTP_PORT || 587,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    try { await transporter.sendMail({ from: `"AutoRent" <${process.env.SMTP_USER}>`, to: correoDestino, subject: asunto, text: texto }); } catch (e) { console.error(e); }
}

// ===============================
// 🔹 BASE DE DATOS (Optimizado: No pedimos imágenes)
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        // Filtramos solo los datos necesarios para texto, eliminando la carga de URLs de imagen
        return data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Vehiculo: `${a.Marca} ${a.Modelo}`,
                Precio: a.Precio_Por_Dia,
                Tipo: a.Tipo || "Sedan", // Agregado para el link
                Transmision: a.Transmision || "Automatica"
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
    } catch (e) { console.error(e); }
}

// ===============================
// 🚀 WEBHOOK MODIFICADO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    const autos = await obtenerAutos();

    // Prompt actualizado para que Groq genere el link en lugar de manejar archivos
    const promptSistema = `
Eres un asistente de renta de autos. 
Tu objetivo es ayudar al usuario a elegir un auto y enviarle un LINK con los resultados.

Autos disponibles actualmente:
${JSON.stringify(autos)}

Instrucciones:
1. NO menciones imágenes.
2. Si el usuario busca algo específico, construye el link usando esta base: ${CATALOGO_URL}?tipo=VALOR&marca=VALOR
3. Responde SIEMPRE en este formato JSON:
{
 "respuesta_usuario": "Texto amable indicando que pueden ver los autos en el link: [LINK_AQUI]",
 "accion": "hablar",
 "link_generado": "[LINK_CON_FILTROS]",
 "datos_reserva": { "Modelo": "", "Folio": "" }
}
`;

    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }

    const historial = sesiones.get(sessionId);
    historial[0].content = promptSistema;
    historial.push({ role: "user", content: queryText });

    try {
        const respuesta = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.2
        });

        let contenido = respuesta.choices[0].message.content;
        const json = JSON.parse(contenido.trim());

        historial.push({ role: "assistant", content: JSON.stringify(json) });

        // Lógica de acciones
        if (json.accion === "guardar_reserva") await guardarReserva(json.datos_reserva);

        // Enviamos la respuesta de texto que ya incluye el link construido por la IA
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
        console.error("❌ ERROR:", error);
        res.json({ fulfillmentText: "Lo siento, tuve un problema al procesar los autos." });
    }
});

app.listen(port, () => {
    console.log("🚀 Servidor corriendo en puerto", port);
});
