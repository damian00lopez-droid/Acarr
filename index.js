require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();

// 1. MIDDLEWARES
app.use(express.json());
// 🟢 MUY IMPORTANTE: Esto le dice a tu servidor que muestre la página web
app.use(express.static('public')); 

// 2. CONFIGURACIÓN Y VARIABLES DE ENTORNO
const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const ULTRAMSG_INSTANCE = process.env.ULTRAMSG_INSTANCE_ID; 
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN;
const NUMERO_EMPRESA = "525555555555"; // Cambia por tu número real

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const sesiones = new Map();

// ===============================
// 🔹 FUNCIONES DE COMUNICACIÓN
// ===============================
async function enviarWhatsApp(numero, mensaje) {
    try {
        const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`;
        const params = new URLSearchParams({
            token: ULTRAMSG_TOKEN,
            to: numero.replace(/\D/g, ''),
            body: mensaje
        });
        await fetch(url, { method: 'POST', body: params });
        console.log(`✅ WhatsApp enviado a ${numero}`);
    } catch (e) { console.error("❌ Error WhatsApp:", e); }
}

async function enviarCorreo(destinatario, datos) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: destinatario,
            subject: `Confirmación AutoRent - Folio: ${datos.Folio}`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2 style="color: #25D366;">¡Reserva Confirmada!</h2>
                    <p>Hola <strong>${datos.Nombre}</strong>, gracias por elegir AutoRent AI.</p>
                    <ul>
                        <li><strong>Folio:</strong> ${datos.Folio}</li>
                        <li><strong>Vehículo:</strong> ${datos.Modelo}</li>
                        <li><strong>Días:</strong> ${datos.Fecha_inicio} al ${datos.Fecha_fin}</li>
                    </ul>
                    <p>¡Te esperamos!</p>
                </div>
            `
        });
        console.log(`📧 Correo enviado a ${destinatario}`);
    } catch (e) { console.error("❌ Error Correo:", e); }
}

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function buscarAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        return data.filter(a => a.Disponibilidad === 'Disponible');
    } catch (error) {
        console.error("❌ Error SheetDB:", error);
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
        console.log(`✅ Reserva guardada: Folio ${datos.Folio}`);
    } catch (e) { console.error("❌ Error guardando reserva:", e); }
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL DE IA
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    
    console.log(`\n[Usuario] -> ${queryText}`);

    // URL dinámica para tu página (Cambia localhost por tu link de Render cuando lo subas)
    const URL_BASE_CATALOGO = process.env.URL_SITIO || `http://localhost:${port}/catalogo.html`;

    const promptSistema = `
    Eres AutoRent AI, el asistente experto en renta de autos.

    REGLAS ESTRICTAS:
    1. Si el usuario saluda, preséntate y pregunta qué tipo de auto busca (coche, camioneta, automático, manual, cantidad de pasajeros).
    2. Si el usuario da sus preferencias (ej. "busco un automático de 4 puertas"), SIEMPRE envíalo a nuestro catálogo web dinámico para que vea las fotos.
       Usa este formato de enlace: ${URL_BASE_CATALOGO}?transmision=[Transmision]&puertas=[Puertas]&asientos=[Asientos]&categoria=[Categoria]
       (Llena los corchetes solo con la información que el usuario te dio. Si no te dio alguna, déjalo en blanco).
    3. Cuando el usuario elija un auto (regresará del catálogo web con un mensaje predefinido), pídele: Nombre completo, Teléfono (WhatsApp), Correo electrónico y Fechas.
    4. Al tener todos los datos, genera un FOLIO aleatorio de 6 caracteres.
    5. Confirma la reserva y dile que le llegará un correo y un WhatsApp.

    FORMATO JSON OBLIGATORIO DE RESPUESTA:
    {
        "respuesta_usuario": "Tu texto amigable para el usuario aquí.",
        "accion": "hablar" | "guardar_reserva",
        "datos_reserva": { "Nombre":"", "Telefono":"", "Email":"", "Modelo":"", "Fecha_inicio":"", "Fecha_fin":"", "Folio":"" },
        "preferencias": { "Transmision": "", "Puertas": "", "Asientos": "", "Categoria": "" }
    }
    `;

    // Manejo de Memoria de la Sesión
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);
    historial[0].content = promptSistema; // Refrescar siempre las reglas
    historial.push({ role: "user", content: queryText });

    // Mantener solo los últimos 8 mensajes para no saturar la API
    if (historial.length > 8) historial.splice(1, historial.length - 8);

    try {
        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.4
        });

        const iaJSON = JSON.parse(completion.choices[0].message.content);

        // EJECUTAR ACCIONES SI EL USUARIO CONFIRMÓ
        if (iaJSON.accion === "guardar_reserva") {
            // 1. Guardar en Excel
            await guardarReserva({ ...iaJSON.datos_reserva, Estado: "Confirmado" });
            
            // 2. Enviar WhatsApp real
            if (iaJSON.datos_reserva.Telefono) {
                await enviarWhatsApp(
                    iaJSON.datos_reserva.Telefono, 
                    `¡Hola ${iaJSON.datos_reserva.Nombre}! 🚗 Tu reserva del ${iaJSON.datos_reserva.Modelo} está confirmada.\n\n📄 Folio: *${iaJSON.datos_reserva.Folio}*\n\n¡Gracias por confiar en AutoRent AI!`
                );
            }

            // 3. Enviar Correo electrónico real
            if (iaJSON.datos_reserva.Email) {
                await enviarCorreo(iaJSON.datos_reserva.Email, iaJSON.datos_reserva);
            }
        }

        // Guardar la respuesta de la IA en la memoria
        historial.push({ role: "assistant", content: JSON.stringify(iaJSON) });
        
        // Devolver el texto a la plataforma de chat (Dialogflow/Telegram)
        return res.json({ fulfillmentText: iaJSON.respuesta_usuario });

    } catch (error) {
        console.error("❌ Error en procesamiento de IA:", error);
        return res.json({ fulfillmentText: "Hubo un pequeño error técnico. ¿Podrías repetirme eso?" });
    }
});

app.listen(port, () => console.log(`🚀 AutoRent AI funcionando en el puerto ${port}`));

// ===============================
app.listen(port, () => {
    console.log(`🚀 Servidor AutoRent corriendo en puerto ${port}`);
});
