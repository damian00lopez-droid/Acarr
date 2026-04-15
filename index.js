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
        
        // 🔥 OPTIMIZACIÓN DE TOKENS: 
        // Filtramos y mapeamos SOLO lo esencial para no saturar a la IA
        return data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Modelo: a.Modelo,
                Precio: a.Precio_Por_Dia
            }));
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
    const intentDetectado = req.body.queryResult.intent?.displayName || "Desconocido";

    console.log(`\n[Intent] -> ${intentDetectado} | [Usuario] -> ${queryText}`);

    // Obtenemos el inventario "ligero"
    const autosDisponibles = await obtenerAutos();

    const promptSistema = `
    Eres AutoRent AI, un asistente amable de renta de autos.
    PISTA: Dialogflow clasificó esto como "${intentDetectado}". Usa esto para guiarte.

    AUTOS DISPONIBLES: ${JSON.stringify(autosDisponibles)}

    REGLAS:
    1. Si saludan (Default Welcome Intent): Saluda con entusiasmo y muestra opciones (Rentar, Requisitos, Soporte).
    2. Si rentan: Pide fechas de inicio/fin. Multiplica los días por el Precio del auto.
    3. Ofrece extras: GPS ($10 total) o Seguro ($20 total).
    4. Confirmación: Genera un folio (ej. RES-1234), agradece y pon accion a "guardar_reserva".

    RESPONDE SÓLO CON ESTE JSON ESTRICTO (sin usar etiquetas Markdown como \`\`\`json):
    {
        "respuesta_usuario": "Tu mensaje aquí.",
        "accion": "hablar", 
        "datos_reserva": { 
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

    // Actualizar el prompt del sistema
    historial[0].content = promptSistema; 
    historial.push({ role: "user", content: queryText });

    // 🔥 OPTIMIZACIÓN DE MEMORIA 🔥
    // Si el historial crece mucho, mantenemos solo el System Prompt (índice 0) y los últimos 6 mensajes
    if (historial.length > 7) {
        historial.splice(1, historial.length - 7);
    }

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA JSON Crudo] ->`, contenidoIA);

        // 🔥 PARCHE DE LIMPIEZA JSON 🔥
        // Quitamos basura que la IA pueda agregar por error
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);

        const iaJSON = JSON.parse(jsonLimpio);

        historial.push({ role: "assistant", content: jsonLimpio });

        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Guardando en base de datos...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado"
            });
            sesiones.delete(sessionId); // Limpiamos sesión al terminar la reserva
        }

        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error con Groq:", error.message || error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeño tropiezo procesando tanta información. ¿Podrías ser un poco más breve o repetirme lo último?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook Híbrido Optimizado funcionando en puerto", port));
