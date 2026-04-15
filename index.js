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
            
        console.log("🚗 Autos cargados:", autosListos);
        return autosListos;
        
    } catch (error) {
        console.error("❌ Error consultando autos en SheetDB:", error);
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
        console.error("❌ Error guardando la reserva:", error);
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
        console.error("❌ Error cancelando la reserva:", error);
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

    // 🔥 CEREBRO REPROGRAMADO (A PRUEBA DE FALLOS)
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DE AUTOS DISPONIBLES:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE FLUJO (SÍGUELAS PASO A PASO OBLIGATORIAMENTE):
    1. SALUDO, NOMBRE Y MENÚ: Si el usuario saluda, preséntate, pregúntale su NOMBRE y copia y pega EXACTAMENTE este menú en tu respuesta:
       "¿En qué te puedo ayudar hoy?
       🚗 Rentar un auto
       ❌ Cancelar reserva
       📋 Ver requisitos
       🎧 Soporte"
    2. MOSTRAR CATÁLOGO: Si el usuario quiere rentar, ES OBLIGATORIO que le escribas la lista completa de autos disponibles con sus precios en ese mismo momento.
    3. FECHAS Y COTIZACIÓN: Cuando elija un auto, pide fechas de inicio y fin. Calcula el total (Días x Precio). Ofrécele GPS ($10) o Seguro ($20).
    4. CONFIRMAR RENTA Y MOSTRAR FOLIO: Pídele que confirme. Si acepta, inventa un folio (ej. RES-5555), **DÍSELO CLARAMENTE EN TU MENSAJE ("Tu folio de reserva es: RES-5555. Por favor guárdalo")**, despídete por su nombre y cambia la "accion" a "guardar_reserva".
    5. CANCELAR RESERVA: Si el usuario quiere cancelar, pídele su número de Folio. Cuando te lo dé y confirme, cambia la "accion" a "cancelar_reserva", pon el folio en "datos_reserva.Folio" y **DILE TEXTUALMENTE EN TU MENSAJE: "Tu reserva con folio [FOLIO] ha sido cancelada exitosamente."**

    FORMATO OBLIGATORIO (JSON ESTRICTO):
    {
        "respuesta_usuario": "Tu mensaje detallado aquí. RECUERDA: Si es saludo, incluye el menú exacto. Si es confirmación, muéstrale su FOLIO para que lo anote. Si es cancelación, dile que ha sido cancelada exitosamente.",
        "accion": "hablar", 
        "datos_reserva": { 
            "Nombre": "",
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
            temperature: 0.3
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA Decidió] ->`, contenidoIA);

        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);

        const iaJSON = JSON.parse(jsonLimpio);
        historial.push({ role: "assistant", content: jsonLimpio });

        // EJECUTAR ACCIÓN SEGÚN LO QUE DECIDIÓ LA IA
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Mandando reserva a Google Sheets...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado" 
            });
            sesiones.delete(sessionId); 

        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva ${iaJSON.datos_reserva.Folio} en Google Sheets...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);
            sesiones.delete(sessionId);
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

app.listen(port, () => console.log("🚀 Webhook IA Definitivo funcionando en puerto", port));
