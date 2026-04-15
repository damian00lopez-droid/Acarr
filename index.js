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

// 🟢 TU NÚMERO DE WHATSAPP PARA RECIBIR MENSAJES (Cámbialo por el tuyo)
const NUMERO_EMPRESA = "525555555555"; 

// ===============================
// 🔹 FUNCIÓN PARA WHATSAPP AUTOMÁTICO
// ===============================
async function enviarWhatsAppAutomatico(numero, mensaje) {
    const numeroLimpio = numero.replace(/\D/g, '');
    console.log(`[WhatsApp API] Simulando envío automático a ${numeroLimpio}: ${mensaje}`);
    // Aquí irá tu conexión a la API de Meta (WhatsApp) cuando decidas activarla
}

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
    // Evitamos crasheos si la petición viene vacía
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    const intentDetectado = req.body.queryResult?.intent?.displayName || "Desconocido";

    console.log(`\n[Intent: ${intentDetectado}] | [Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();

    // 🔥 CEREBRO REPROGRAMADO (Con enlaces a WhatsApp)
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DISPONIBLE (AUTOS Y PRECIOS):
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE COMPORTAMIENTO:
    1. EL SALUDO Y EL MENÚ VAN JUNTOS: Cuando te saluden, pregunta el nombre y muestra OBLIGATORIAMENTE el menú:
       🚗 Rentar un auto
       ❌ Cancelar reserva
       📋 Ver requisitos
       🎧 Soporte

    2. MOSTRAR EL CATÁLOGO: Si el usuario quiere rentar, TIENES QUE ESCRIBIR textualmente el nombre y precio de CADA auto disponible.

    3. FECHAS Y TELÉFONO: Cuando elija auto, pide fechas, calcula el total, ofrece extras Y PÍDELE SU NÚMERO DE WHATSAPP para el registro.

    4. CONFIRMAR Y WHATSAPP DE RESERVA: Si acepta, genera un FOLIO ALEATORIO (ej. RES-8A4Z). 
       Dile textualmente: "Tu reserva está confirmada, [Nombre]. Tu folio es [FOLIO]. Para enviarnos los datos de tu reserva a nuestro WhatsApp, haz clic en este enlace: https://wa.me/${NUMERO_EMPRESA}?text=Hola,%20confirmo%20mi%20reserva%20con%20folio%20[PON_AQUI_EL_FOLIO_GENERADO]"
       Cambia "accion" a "guardar_reserva" y pregunta: "¿Deseas iniciar un nuevo trámite?".

    5. SOPORTE POR WHATSAPP: Si el usuario elige "Soporte", indícale que un humano le atenderá dándole ESTE ENLACE EXACTO: "Haz clic aquí para hablar con un agente: https://wa.me/${NUMERO_EMPRESA}?text=Hola,%20necesito%20ayuda%20con%20AutoRent"

    6. CANCELAR: Si quiere cancelar, pide el Folio. Al confirmar, cambia "accion" a "cancelar_reserva" y dile: "Tu reserva con folio [FOLIO] ha sido cancelada. ¿Deseas iniciar un nuevo trámite?".

    FORMATO JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Aquí va TODO tu texto para el usuario.",
        "accion": "hablar", 
        "datos_reserva": { 
            "Nombre": "El nombre del cliente",
            "Telefono": "El teléfono que te dio el cliente",
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
        console.log(`[IA JSON Crudo] ->`, contenidoIA);

        // 🔥 PARCHE DE LIMPIEZA JSON 🔥
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        
        // Seguro por si Groq se vuelve loco y no envía JSON
        if(inicioJSON === -1 || finJSON === 0) {
            throw new Error("No se pudo extraer JSON de la respuesta.");
        }

        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);
        const iaJSON = JSON.parse(jsonLimpio);
        
        // 🔥 INYECCIÓN DE SEGURIDAD (MENÚ Y AUTOS) 🔥
        // Esto garantiza que el menú y los autos siempre se muestren, aunque la IA sea "perezosa"
        if (intentDetectado === "Default Welcome Intent" || queryText.toLowerCase().includes('hola')) {
            if (!iaJSON.respuesta_usuario.includes('Rentar')) {
                iaJSON.respuesta_usuario += "\n\n¿En qué te puedo ayudar hoy?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
            }
        }
        
        if (queryText.toLowerCase().includes('rentar') || queryText.toLowerCase().includes('auto')) {
             if (!iaJSON.respuesta_usuario.includes('$')) {
                  iaJSON.respuesta_usuario += "\n\nAquí tienes nuestros autos disponibles:\n";
                  autosDisponibles.forEach(a => {
                      iaJSON.respuesta_usuario += `- ${a.Vehiculo}: $${a.Precio}\n`;
                  });
             }
        }

        historial.push({ role: "assistant", content: jsonLimpio });

        // EJECUTAR ACCIONES FINALES
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Mandando reserva a Google Sheets...");
            await guardarReserva({
                ...iaJSON.datos_reserva,
                Estado: "Confirmado" 
            });
            if (iaJSON.datos_reserva.Telefono) {
                await enviarWhatsAppAutomatico(
                    iaJSON.datos_reserva.Telefono, 
                    `¡Hola ${iaJSON.datos_reserva.Nombre}! Tu reserva está confirmada. Folio: ${iaJSON.datos_reserva.Folio}`
                );
            }
        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);
            if (iaJSON.datos_reserva.Telefono) {
                await enviarWhatsAppAutomatico(
                    iaJSON.datos_reserva.Telefono, 
                    `¡Hola ${iaJSON.datos_reserva.Nombre}. Tu reserva con folio ${folioMayusculas} ha sido cancelada exitosamente.`
                );
            }
        }

        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error grave en webhook:", error.message || error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeñísimo tropiezo técnico. ¿Serías tan amable de repetirme lo último que dijiste?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA funcionando en puerto", port));
