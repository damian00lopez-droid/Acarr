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
            
        console.log("🚗 Autos extraídos de la base de datos:", autosListos);
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

    // 🔥 CEREBRO REPROGRAMADO PARA EVITAR QUE LA IA SEA "PEREZOSA"
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DISPONIBLE (AUTOS Y PRECIOS):
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE COMPORTAMIENTO (¡CUMPLE TODAS AL PIE DE LA LETRA!):
    1. EL SALUDO Y EL MENÚ VAN JUNTOS: Cuando el usuario te salude (ej. "Hola"), TIENES QUE responder preguntando su nombre y mostrando el menú en el MISMO mensaje.
       Ejemplo OBLIGATORIO: "¡Hola! Soy AutoRent AI. ¿Cuál es tu nombre? Mientras tanto, te dejo nuestro menú:
       🚗 Rentar un auto
       ❌ Cancelar reserva
       📋 Ver requisitos
       🎧 Soporte"
       ¡NUNCA saludes sin incluir el menú exacto de arriba!

    2. MOSTRAR EL CATÁLOGO (¡NO SEAS PEREZOSO!): Si el usuario dice que quiere rentar, está ESTRICTAMENTE PROHIBIDO decir "Aquí tienes la lista" y dejarla en blanco. TIENES QUE ESCRIBIR textualmente el nombre y precio de CADA auto del INVENTARIO DISPONIBLE dentro de tu respuesta.
       Ejemplo de lo que DEBES hacer: "Aquí tienes los autos: 1. Kia Rio - $500, 2. Nissan March - $400..."

    3. COTIZACIÓN: Cuando elija auto, pide fechas, calcula total (Días x Precio) y ofrece extras (GPS $10, Seguro $20).

    4. CONFIRMAR Y GENERAR FOLIO: Si confirma la renta, genera un FOLIO ALEATORIO (ej. RES-8A4Z). Dile: "Tu reserva está confirmada. Tu folio es [FOLIO]". Cambia "accion" a "guardar_reserva" y pregunta al final: "¿Deseas iniciar un nuevo trámite?".

    5. CANCELAR: Si quiere cancelar, pide el Folio. Al confirmar que lo cancela, cambia "accion" a "cancelar_reserva" y dile: "Tu reserva con folio [FOLIO] ha sido cancelada. ¿Deseas iniciar un nuevo trámite?".

    FORMATO JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Aquí va TODO tu texto. ¡Asegúrate de ESCRIBIR aquí adentro el catálogo de autos o el menú cuando corresponda!",
        "accion": "hablar", 
        "datos_reserva": { 
            "Nombre": "El nombre del cliente",
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
            temperature: 0.5 
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA Decidió] ->`, contenidoIA);

        // Limpieza de JSON
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
