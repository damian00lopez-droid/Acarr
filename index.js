require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch'); // Requerido en Node.js < 18
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Memoria para guardar el historial de conversación de cada usuario
const sesiones = new Map();

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        
        // OPTIMIZACIÓN: Solo traemos los disponibles y unimos Marca + Modelo
        // Esto evita el error de "Request too large" en Groq.
        return data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Vehiculo: `${a.Marca} ${a.Modelo}`, // Ej: "Kia Rio"
                Precio: a.Precio_Por_Dia
            }));
    } catch (error) {
        console.error("❌ Error consultando autos en SheetDB:", error);
        return [];
    }
}

async function guardarReserva(datos) {
    try {
        // IMPORTANTE: Se agrega ?sheet=Reservas para guardar en la pestaña correcta
        const urlDestino = `${sheetdbUrl}?sheet=Reservas`;
        
        await fetch(urlDestino, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [datos] })
        });
        console.log("✅ ¡Reserva guardada exitosamente en el Excel!", datos);
    } catch (error) {
        console.error("❌ Error guardando la reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK IA HÍBRIDO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult.queryText;
    const sessionId = req.body.session;
    // Capturamos el intent que Dialogflow detectó para dar contexto a la IA
    const intentDetectado = req.body.queryResult.intent?.displayName || "Desconocido";

    console.log(`\n[Intent: ${intentDetectado}] | [Usuario] -> ${queryText}`);

    // 1. Obtenemos el inventario fresco y ligero
    const autosDisponibles = await obtenerAutos();

    // 2. Construimos el "Cerebro" de la IA
    const promptSistema = `
    Eres AutoRent AI, un asistente experto, amable y servicial de renta de autos.
    PISTA DE CONTEXTO: Dialogflow clasificó la intención del usuario como "${intentDetectado}". Usa esto como guía inicial.

    INVENTARIO ACTUAL DISPONIBLE:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE COMPORTAMIENTO:
    1. SI SALUDAN (Default Welcome Intent): Saluda con gran actitud y ofrece tu menú principal (Rentar, Requisitos, Soporte).
    2. SI QUIEREN RENTAR: Muestra los autos disponibles con sus precios. 
    3. COTIZACIÓN: Cuando elijan, pide fechas de inicio y fin. Multiplica los días por el Precio del vehículo.
    4. EXTRAS: Siempre sugiere amablemente agregar GPS ($10 total por renta) o Seguro Completo ($20 total por renta).
    5. CONFIRMACIÓN: Cuando el usuario acepte y confirme la renta, inventa un folio (ej. RES-8492), agradécele y cambia la accion a "guardar_reserva".
    6. DUDAS: Si preguntan requisitos, menciona: INE, licencia vigente y tarjeta de crédito.

    FORMATO OBLIGATORIO (JSON ESTRICTO):
    {
        "respuesta_usuario": "Tu mensaje amigable y humano aquí.",
        "accion": "hablar", // Cambia a "guardar_reserva" SOLO cuando el cliente confirme todo.
        "datos_reserva": { // Llena esto SOLO si la accion es guardar_reserva
            "Modelo": "",
            "Fecha_inicio": "",
            "Fecha_fin": "",
            "Extras": "",
            "Folio": ""
        }
    }
    `;

    // 3. Inicializamos o recuperamos el historial del usuario
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);

    // Actualizamos el inventario en el historial por si cambió en tiempo real
    historial[0].content = promptSistema; 
    
    // Agregamos el mensaje del usuario
    historial.push({ role: "user", content: queryText });

    // 🔥 OPTIMIZACIÓN DE MEMORIA 🔥
    // Evita saturar a la IA guardando solo el System Prompt (índice 0) y los últimos 6 mensajes
    if (historial.length > 7) {
        historial.splice(1, historial.length - 7);
    }

    try {
        // 4. Llamada al modelo Llama 3.1
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA Decidió] ->`, contenidoIA);

        // 🔥 PARCHE DE LIMPIEZA JSON 🔥
        // Previene errores críticos si la IA agrega texto basura como ```json antes de las llaves
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);

        const iaJSON = JSON.parse(jsonLimpio);

        // Guardamos la respuesta procesada en el historial
        historial.push({ role: "assistant", content: jsonLimpio });

        // 5. Ejecutar acciones si la IA decidió guardar la renta
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Mandando datos a Google Sheets...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado" // Estado por defecto para las nuevas reservas
            });
            
            // Limpiamos la sesión porque el flujo de renta ya terminó
            sesiones.delete(sessionId); 
        }

        // 6. Respondemos a Dialogflow
        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error grave en webhook:", error.message || error);
        
        // Respuesta de emergencia si la API de Groq falla o hay un error de sintaxis
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeñísimo tropiezo de red. ¿Serías tan amable de repetirme lo último que dijiste?"
        });
    }
});

// Inicializar el servidor
app.listen(port, () => console.log("🚀 Webhook IA Definitivo funcionando en puerto", port));
