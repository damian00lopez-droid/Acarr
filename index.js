require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sesiones = new Map();

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        return data.filter(a => a.Disponibilidad === 'Disponible');
    } catch (error) {
        console.error("Error consultando SheetDB:", error);
        return [];
    }
}

async function guardarReserva(datos) {
    try {
        await fetch(sheetdbUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [datos] })
        });
        console.log("✅ Reserva guardada exitosamente en SheetDB:", datos);
    } catch (error) {
        console.error("Error guardando la reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK IA HÍBRIDO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult.queryText;
    const sessionId = req.body.session;
    // Extraemos el Intent que Dialogflow detectó para usarlo como pista
    const intentDetectado = req.body.queryResult.intent?.displayName || "Desconocido";

    console.log(`\n[Intent] -> ${intentDetectado} | [Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();

    // 2. Construir el Prompt del Sistema (Más amigable y estructurado)
    const promptSistema = `
    Eres AutoRent AI, el asistente virtual más amable, empático y servicial para renta de autos.
    Tu tono debe ser cálido, usar emojis de forma natural (sin exagerar) y hacer sentir al usuario muy bien atendido.

    PISTA DE CONTEXTO: Dialogflow clasificó la intención del usuario como "${intentDetectado}". Usa esto para guiar tu respuesta.

    INVENTARIO ACTUAL:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE COMPORTAMIENTO:
    1. SI EL USUARIO SALUDA O INICIA (Intent: Default Welcome Intent): Salúdalo con mucho entusiasmo y muéstrale este menú de opciones:
       🚗 Rentar un vehículo
       📋 Ver requisitos y seguros
       ❌ Cancelar o consultar una reserva
       🎧 Hablar con soporte

    2. SI QUIERE RENTAR (Intent: Reserva o Cotizacion): Muestra SOLO los autos disponibles. Luego, pide amablemente las fechas de inicio y fin. Calcula el total multiplicando los días por el Precio_Por_Dia.
    
    3. EXTRAS: Antes de confirmar, siempre sugiere agregar GPS ($10 total) o Seguro Completo ($20 total).
    
    4. CONFIRMACIÓN: Cuando el usuario confirme la renta, inventa un folio (ej. RES-1234), agradécele y cambia la accion a "guardar_reserva".
    
    5. OTRAS DUDAS (Requisitos, Soporte, etc.): Responde de forma muy servicial basándote en la intención detectada. (Ej. Requisitos: INE, licencia, tarjeta).

    FORMATO OBLIGATORIO (JSON):
    {
        "respuesta_usuario": "Tu mensaje amigable, humano y formateado aquí.",
        "accion": "hablar", // Cambia a "guardar_reserva" SOLO al confirmar la renta
        "datos_reserva": { // Llena esto SOLO si vas a guardar_reserva
            "Modelo": "",
            "Fecha_inicio": "",
            "Fecha_fin": "",
            "Extras": "",
            "Folio": ""
        }
    }
    `;

    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);

    // Mantenemos el prompt del sistema actualizado
    historial[0].content = promptSistema; 
    historial.push({ role: "user", content: queryText });

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3 // Un poquito más de temperatura para que suene más natural y menos robot
        });

        const contenidoIA = respuestaGroq.choices[0].message.content;
        const iaJSON = JSON.parse(contenidoIA);

        historial.push({ role: "assistant", content: contenidoIA });

        // Si la IA decide que ya se completó el flujo de reserva
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Guardando en base de datos...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado"
            });
            sesiones.delete(sessionId); 
        }

        // Devolvemos la respuesta amigable a Dialogflow
        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error con Groq:", error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeño tropiezo técnico por un momento. ¿Podrías repetirme lo último que me dijiste, por favor?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook Híbrido funcionando en el puerto", port));
