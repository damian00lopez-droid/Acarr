require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // Si usas Node.js 18+, puedes borrar esta línea
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
        // Filtramos solo los disponibles
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
// 🚀 WEBHOOK PRINCIPAL (AGENTE IA)
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult.queryText;
    const sessionId = req.body.session;

    console.log(`\n[Usuario] -> ${queryText}`);

    // 1. Obtener el inventario fresco
    const autosDisponibles = await obtenerAutos();

    // 2. Construir el Prompt del Sistema
    const promptSistema = `
    Eres AutoRent AI, un asistente experto y amigable de renta de autos.
    Tu objetivo es guiar al usuario paso a paso para concretar una renta.
    
    INVENTARIO ACTUAL DISPONIBLE:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS:
    1. Saluda cordialmente si es el inicio de la conversación.
    2. Muestra SÓLO los autos del inventario actual con sus precios.
    3. Para cotizar, DEBES preguntar la fecha de inicio y la fecha de fin. 
    4. Calcula los días y multiplica por el Precio_Por_Dia del auto elegido.
    5. Ofrece siempre extras: GPS ($10 por renta) o Seguro Completo ($20 por renta).
    6. Cuando el usuario confirme que todo es correcto, genera un folio aleatorio (ej. RES-1234) e indícale que su reserva está lista.
    7. Al finalizar la reserva, cambia el valor de "accion" a "guardar_reserva".

    FORMATO DE RESPUESTA OBLIGATORIO (JSON VÁLIDO):
    {
        "respuesta_usuario": "Tu respuesta amable y conversacional aquí.",
        "accion": "hablar", // Cambia a "guardar_reserva" SOLO al final, cuando el usuario confirme.
        "datos_reserva": { // Llena esto SOLO si la accion es guardar_reserva
            "Modelo": "",
            "Fecha_inicio": "",
            "Fecha_fin": "",
            "Extras": "",
            "Folio": ""
        }
    }
    `;

    // 3. Recuperar o inicializar el historial
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);

    // Actualizamos el system prompt para tener siempre el inventario más reciente
    historial[0].content = promptSistema; 
    
    // Agregamos lo que el usuario acaba de decir
    historial.push({ role: "user", content: queryText });

    try {
        // 4. Llamada a la API de Groq
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama3-8b-8192", // Usamos Llama 3 porque es excelente para forzar JSON
            response_format: { type: "json_object" },
            temperature: 0.2 // Muy bajo para que no alucine datos
        });

        const contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA JSON Crudo] ->`, contenidoIA); // Para que veas en consola lo que decide la IA
        
        const iaJSON = JSON.parse(contenidoIA);

        // Guardamos la respuesta en el historial
        historial.push({ role: "assistant", content: contenidoIA });

        // 5. Ejecutar acciones si la IA decidió terminar la reserva
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Preparando guardado en base de datos...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado"
            });
            
            // Limpiamos la memoria de la sesión para futuras consultas
            sesiones.delete(sessionId); 
        }

        // 6. Responder a Dialogflow
        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error con Groq:", error);
        return res.json({
            fulfillmentText: "Lo siento, tuve un pequeño problema técnico procesando tu solicitud. ¿Podrías repetirlo?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA Agente funcionando en el puerto", port));
