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

    // 🔥 CEREBRO REPROGRAMADO: Todo en un solo mensaje inicial
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DISPONIBLE:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE FLUJO (CÚMPLELAS OBLIGATORIAMENTE):
    1. SALUDO, NOMBRE Y MENÚ JUNTOS: Si el usuario saluda, preséntate, pregúntale su nombre Y EN ESE MISMO MENSAJE muéstrale este menú textualmente:
       🚗 Rentar un auto
       ❌ Cancelar reserva
       📋 Ver requisitos
       🎧 Soporte
       (Ejemplo: "¡Hola! Soy AutoRent AI. Para darte un mejor servicio, ¿cuál es tu nombre? Mientras tanto, ¿en qué te puedo ayudar hoy? [MENÚ]")
    2. MOSTRAR CATÁLOGO: Si el usuario quiere rentar, muéstrale la lista de autos con precios inmediatamente.
    3. FECHAS Y EXTRAS: Pide fechas de inicio/fin. Calcula el total. Ofrece GPS ($10) o Seguro ($20). Usa siempre el nombre del cliente si ya te lo dio.
    4. CONFIRMAR RENTA (FOLIO Y NUEVO TRÁMITE): Pídele que confirme. Si acepta, inventa un folio ALEATORIO combinando letras y números (ej. RES-9X4P). Dile textualmente: "Tu reserva está confirmada, [Nombre]. Tu folio es [FOLIO].". Cambia la "accion" a "guardar_reserva", y AL FINAL DEL MENSAJE pregunta: "¿Deseas iniciar un nuevo trámite?".
    5. CANCELAR RESERVA: Si quiere cancelar, pide su Folio. Al confirmar, cambia la "accion" a "cancelar_reserva" y dile: "Tu reserva con folio [FOLIO] ha sido cancelada exitosamente. ¿Deseas iniciar un nuevo trámite?".

    FORMATO JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Tu mensaje aquí.",
        "accion": "hablar", 
        "datos_reserva": { 
            "Nombre": "Anota aquí el nombre real del cliente si ya lo mencionó",
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
        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);
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
