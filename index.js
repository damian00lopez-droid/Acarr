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
        
        const autosListos = data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Vehiculo: `${a.Marca} ${a.Modelo}`,
                Precio: a.Precio_Por_Dia
            }));
            
        return autosListos;
        
    } catch (error) {
        console.error("❌ Error consultando autos:", error);
        return [];
    }
}

async function guardarReserva(datos) {
    try {
        const urlDestino = `${sheetdbUrl}?sheet=Reservas`;
        await fetch(urlDestino, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [datos] })
        });
        console.log("✅ ¡Reserva guardada en el Excel!", datos);
    } catch (error) {
        console.error("❌ Error guardando reserva:", error);
    }
}

async function cancelarReserva(folio) {
    try {
        const urlDestino = `${sheetdbUrl}/Folio/${folio}?sheet=Reservas`;
        await fetch(urlDestino, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { Estado: "Cancelado" } }) 
        });
        console.log(`🚫 ¡Reserva ${folio} cancelada en el Excel!`);
    } catch (error) {
        console.error("❌ Error cancelando reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK IA HÍBRIDO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult.queryText;
    const sessionId = req.body.session;
    const intentDetectado = req.body.queryResult.intent?.displayName || "Desconocido";

    console.log(`\n[Intent: ${intentDetectado}] | [Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();

    // 🔥 CEREBRO REPROGRAMADO: Nombre, Folios Aleatorios y Nuevo Trámite
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DISPONIBLE:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE FLUJO:
    1. PASO 1 - OBTENER NOMBRE: Al iniciar (si te dicen hola), preséntate muy amable y pregunta OBLIGATORIAMENTE: "¿Con quién tengo el gusto?" o "¿Cuál es tu nombre?". NO muestres el menú todavía.
    2. PASO 2 - EL MENÚ: Cuando el usuario te diga su nombre, guárdalo. Salúdalo usando SU NOMBRE REAL (Ej. "¡Qué tal Damián!") y muéstrale este menú textualmente:
       🚗 Rentar un auto
       ❌ Cancelar reserva
       📋 Ver requisitos
       🎧 Soporte
    3. MOSTRAR CATÁLOGO: Si el usuario quiere rentar, muéstrale la lista de autos con precios inmediatamente.
    4. FECHAS Y EXTRAS: Pide fechas de inicio/fin. Calcula el total. Ofrece GPS ($10) o Seguro ($20).
    5. CONFIRMAR RENTA: Pídele que confirme. Si acepta, inventa un folio ALEATORIO y ÚNICO combinando letras y números (ej. RES-9X4P, RES-2M7B. NO uses el mismo siempre), DÍSELO ("Tu folio es [FOLIO]"), despídete usando su nombre, CAMBIA la "accion" a "guardar_reserva", y finalmente PREGÚNTALE: "¿Deseas iniciar un nuevo trámite?".
    6. CANCELAR RESERVA: Si quiere cancelar, pide su Folio. Al confirmar, cambia la "accion" a "cancelar_reserva" y dile textualmente: "Tu reserva con folio [FOLIO] ha sido cancelada exitosamente. ¿Deseas iniciar un nuevo trámite?".

    FORMATO JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Tu mensaje aquí. Recuerda preguntar por un nuevo trámite al finalizar una reserva o cancelación.",
        "accion": "hablar", 
        "datos_reserva": { 
            "Nombre": "Anota aquí el nombre real del cliente",
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

    historial[0].content = promptSistema; 
    historial.push({ role: "user", content: queryText });

    if (historial.length > 7) {
        historial.splice(1, historial.length - 7);
    }

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.5 // Temperatura en 0.5 para generar folios distintos
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA Decidió] ->`, contenidoIA);

        // Parche de seguridad JSON
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);

        const iaJSON = JSON.parse(jsonLimpio);
        historial.push({ role: "assistant", content: jsonLimpio });

        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Mandando reserva a Google Sheets...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado" 
            });
            // La sesión se mantiene viva para preguntar si desea un nuevo trámite
        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);
            // La sesión se mantiene viva para preguntar si desea un nuevo trámite
        }

        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error grave en webhook:", error.message || error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeñísimo tropiezo de red. ¿Serías tan amable de repetirme lo último que dijiste?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA funcionando en puerto", port));
