require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // Quítalo si usas Node 18+
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Memoria temporal para guardar el historial de chat de cada usuario
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
        console.error("Error BD:", error);
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
        console.log("✅ Reserva guardada en SheetDB:", datos);
    } catch (error) {
        console.error("Error guardando reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult.queryText;
    const sessionId = req.body.session; // ID único del usuario en Dialogflow

    console.log(`[Usuario] -> ${queryText}`);

    // 1. Obtener el inventario fresco de la BD
    const autosDisponibles = await obtenerAutos();

    // 2. Construir el Prompt del Sistema (El "Cerebro" de la IA)
    const promptSistema = `
    Eres AutoRent AI, un asistente experto y amigable de renta de autos.
    Tu objetivo es guiar al usuario para concretar una renta.
    
    INVENTARIO ACTUAL:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE COMPORTAMIENTO:
    1. Saluda si es el inicio de la conversación.
    2. Si el usuario pide autos, muéstrale SÓLO los del inventario actual con sus precios.
    3. Para cotizar, DEBES preguntar la fecha de inicio y la fecha de fin. Calcula los días y multiplica por el Precio_Por_Dia del auto elegido.
    4. Ofrece siempre extras: GPS ($10 total) o Seguro ($20 total).
    5. Cuando el usuario confirme que quiere rentar, genera un folio aleatorio (ej. RES-1234) y cambia la acción a "guardar_reserva".

    FORMATO DE RESPUESTA OBLIGATORIO (Debes responder ÚNICAMENTE en este formato JSON válido):
    {
        "respuesta_usuario": "El texto amable que le mostrarás al usuario.",
        "accion": "hablar", // Cambia a "guardar_reserva" SOLO cuando el usuario haya confirmado todo.
        "datos_reserva": { // Llena esto solo si la accion es guardar_reserva, de lo contrario déjalo vacío
            "Modelo": "",
            "Fecha_inicio": "",
            "Fecha_fin": "",
            "Extras": "",
            "Folio": ""
        }
    }
    `;

    // 3. Recuperar o inicializar el historial de chat del usuario
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);

    // Actualizamos el system prompt por si cambiaron los autos en la BD
    historial[0].content = promptSistema; 
    
    // Agregamos el nuevo mensaje del usuario al historial
    historial.push({ role: "user", content: queryText });

    // 4. Llamar a Groq
    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "mixtral-8x7b-32768", // o llama3-70b-8192
            response_format: { type: "json_object" }, // Forzamos a que devuelva JSON
            temperature: 0.3 // Temperatura baja para que sea lógico y no alucine datos
        });

        const contenidoIA = respuestaGroq.choices[0].message.content;
        
        // Parsear el JSON que nos devolvió la IA
        const iaJSON = JSON.parse(contenidoIA);

        // Guardar la respuesta de la IA en el historial para que tenga contexto futuro
        historial.push({ role: "assistant", content: contenidoIA });

        // 5. Ejecutar acciones si la IA lo decidió
        if (iaJSON.accion === "guardar_reserva") {
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado"
            });
            
            // Opcional: Limpiar el historial después de una reserva exitosa
            sesiones.delete(sessionId); 
        }

        // 6. Responder a Dialogflow
        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("Error procesando con Groq:", error);
        return res.json({
            fulfillmentText: "Lo siento, tuve un pequeño problema técnico procesando tu solicitud. ¿Podrías repetirlo?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA Agente funcionando en puerto", port));
