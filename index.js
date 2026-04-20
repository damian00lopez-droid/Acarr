require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// ===============================
// 🔥 CONFIGURACIÓN
// ===============================
const CATALOGO_URL = process.env.CATALOGO_URL || "https://acarr-v3a2.onrender.com/catalogo.html";
const MAX_HISTORIAL = 14;

const RAW_KEY = process.env.GROQ_API_KEY || "";
const CLEAN_KEY = RAW_KEY.trim();

if (!CLEAN_KEY) {
    console.error("❌ ERROR: GROQ_API_KEY no encontrada");
    process.exit(1);
}

const groq = new Groq({ apiKey: CLEAN_KEY });
const sesiones = new Map();

let cacheAutos = {
    data: [],
    lastUpdate: null,
    ttl: 10 * 60 * 1000 // 10 minutos
};

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS (SHEETDB)
// ===============================
async function obtenerAutos() {
    try {
        if (cacheAutos.data.length > 0 && cacheAutos.lastUpdate && (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            return cacheAutos.data;
        }

        console.log("🔄 Actualizando catálogo desde SheetDB...");
        const res = await fetch(sheetdbUrl);
        if (!res.ok) throw new Error(`SheetDB ${res.status}`);

        const data = await res.json();
        const autosProcesados = data
            .filter(a => a.Disponibilidad === 'Disponible' || a.Disponibilidad === 'DISPONIBLE')
            .map(a => ({
                marca: a.Marca || '',
                modelo: a.Modelo || '',
                vehiculo: `${a.Marca} ${a.Modelo}`,
                precio: parseFloat(a.Precio_Por_Dia) || 0,
                tipo: a.Categoria || a.Tipo || 'Sedan',
                transmision: a.Transmision || 'Automática',
                puertas: a.Puertas || '4',
                pasajeros: a.Asientos || a.Pasajeros || '5'
            }));

        cacheAutos = { data: autosProcesados, lastUpdate: Date.now(), ttl: cacheAutos.ttl };
        console.log(`✅ ${autosProcesados.length} autos en caché`);
        return autosProcesados;
    } catch (error) {
        console.error("❌ Error obteniendo autos:", error);
        return cacheAutos.data.length ? cacheAutos.data : [];
    }
}

async function guardarReservaEnExcel(cliente, reserva) {
    try {
        const folio = `AR-${Date.now().toString(36).toUpperCase()}`;

        const registro = {
            Nombre: cliente.nombre,
            Telefono: cliente.telefono || "No proporcionado",
            Correo: cliente.correo,
            Modelo: reserva.vehiculo,
            Fecha_Inicio: reserva.fecha_inicio,
            Fecha_Fin: reserva.fecha_fin,
            Extras: "",
            Folio: folio,
            Estado: 'Confirmado'
        };

        const res = await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [registro] })
        });

        if (res.ok) {
            console.log(`✅ Reserva guardada con folio ${folio}`);
            return folio;
        }
        return null;
    } catch (error) {
        console.error("❌ Error guardando en Excel:", error);
        return null;
    }
}

async function cancelarReservaEnExcel(folio) {
    try {
        // 1. Buscar la fila por el folio
        const searchRes = await fetch(`${sheetdbUrl}/search?sheet=Reservas&Folio=${folio}`);
        const data = await searchRes.json();
        if (!data || data.length === 0) {
            console.warn(`⚠️ Folio ${folio} no encontrado`);
            return false;
        }

        const rowId = data[0].id; // SheetDB asigna un ID único a cada fila

        // 2. Actualizar el estado a 'Cancelada' usando el ID
        const updateResponse = await fetch(`${sheetdbUrl}/id/${rowId}?sheet=Reservas`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: { Estado: 'Cancelada' }
            })
        });

        if (updateResponse.ok) {
            console.log(`✅ Reserva ${folio} cancelada correctamente`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('❌ Error cancelando reserva:', error);
        return false;
    }
}

// ===============================
// 🔹 GENERADOR DE LINK MEJORADO
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    if (preferencias.puertas) params.append('puertas', preferencias.puertas);
    params.append('ref', 'chat');

    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 PROMPT DEL SISTEMA (USA PLACEHOLDERS)
// ===============================
function generarPromptSistema(autos) {
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente experto de AutoRent.

REGLAS DE ORO (Si las rompes, el sistema fallará):
1. PROHIBIDO INVENTAR URLs: Cuando recomiendes autos o el catálogo, NUNCA escribas una URL. Usa EXACTAMENTE el texto "[LINK_AQUI]". El sistema lo reemplazará.
2. PROHIBIDO INVENTAR FOLIOS: NUNCA inventes folios como AR-001. Cuando confirmes una reserva, usa EXACTAMENTE el texto "[FOLIO_AQUI]". El sistema lo reemplazará.

MENÚ PRINCIPAL (OBLIGATORIO):
Si el usuario saluda ("Hola") o pide el menú, DEBES responder con esta lista EXACTA:
"¡Hola! Bienvenido a AutoRent 🚗. ¿Qué deseas hacer hoy?
1️⃣ Rentar un Auto
2️⃣ Ver Catálogo Completo
3️⃣ Cancelar Reserva
4️⃣ Requisitos para Rentar
5️⃣ Soporte Técnico"

PROCESO 1: RENTAR UN AUTO
- P1: Pregunta sus preferencias (Tipo de auto, pasajeros). Categorías disponibles: ${categoriasDisponibles}.
- P2: Pide Nombre, Correo y Teléfono.
- P3: Cuando tengas datos y preferencias, cambia tu accion a "recomendar" y usa la etiqueta "[LINK_AQUI]". Pídele que regrese a decirte el modelo.
- P4: Cuando te dé el modelo, pide las FECHAS.
- P5: Cuando tengas modelo y fechas, cambia tu accion a "guardar_reserva" y usa "[FOLIO_AQUI]" para confirmar.

OTROS PROCESOS:
- Catálogo: Dile "Aquí tienes nuestro catálogo: [LINK_AQUI]".
- Cancelar: Pide su Folio. Cuando lo dé, cambia a "cancelar_reserva". NUNCA preguntes "¿Estás seguro?".
- Requisitos: INE/Pasaporte, Licencia vigente, Tarjeta de Crédito, mayor de 21 años.
- Soporte: Pide su teléfono para WhatsApp.

FORMATO JSON OBLIGATORIO:
{
  "respuesta_usuario": "Tu mensaje usando [LINK_AQUI] o [FOLIO_AQUI] según corresponda...",
  "accion": "charlar" | "recomendar" | "guardar_reserva" | "cancelar_reserva",
  "datos_cliente": { "nombre": "", "correo": "", "telefono": "" },
  "datos_reserva": { "vehiculo": "", "fecha_inicio": "", "fecha_fin": "", "folio_a_cancelar": "" },
  "preferencias_detectadas": { "tipo": "", "marca": "", "transmision": "", "precio_max": "", "pasajeros": "", "puertas": "" }
}`;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES (con control de acciones)
// ===============================
function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, {
            historial: [{ role: "system", content: promptSistema }],
            reservaGuardada: false,
            cancelacionRealizada: false
        });
    }

    const sessionData = sesiones.get(sessionId);
    let historial = sessionData.historial;

    historial[0].content = promptSistema;

    if (historial.length > MAX_HISTORIAL) {
        sessionData.historial = [historial[0], ...historial.slice(-MAX_HISTORIAL + 1)];
    }

    return sessionData;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || `sess_${Date.now()}`;

        const autos = await obtenerAutos();
        if (autos.length === 0) {
            return res.json({
                fulfillmentText: "⚠️ Nuestro catálogo no está disponible en este momento. Por favor, intenta más tarde."
            });
        }

        const promptSistema = generarPromptSistema(autos);
        const sessionData = gestionarSesion(sessionId, promptSistema);
        const historial = sessionData.historial;

        // Forzar Menú Inicial si el usuario dice palabras clave
        const palabrasMenu = ['hola', 'menú', 'menu', 'inicio', 'buenos dias', 'buenas tardes'];
        if (historial.length === 1 || palabrasMenu.includes(queryText.toLowerCase().trim())) {
            historial.push({
                role: "system",
                content: "El usuario está pidiendo el inicio. RESPONDE EXACTAMENTE CON LA LISTA DE LAS 5 OPCIONES NUMERADAS DEL MENÚ PRINCIPAL."
            });
        }

        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // ===============================
        // ACCIÓN: RECOMENDAR O MOSTRAR CATÁLOGO
        // ===============================
        if (respuestaIA.accion === "recomendar" || respuestaFinal.includes("[LINK_AQUI]")) {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            respuestaFinal = respuestaFinal.replace("[LINK_AQUI]", linkSeguro);
        }

        // ===============================
        // ACCIÓN: GUARDAR RESERVA
        // ===============================
        if (respuestaIA.accion === "guardar_reserva") {
            if (sessionData.reservaGuardada) {
                respuestaFinal = "Tu reserva ya fue registrada. ¿Necesitas algo más?";
                respuestaIA.accion = "charlar";
            } else {
                const cliente = respuestaIA.datos_cliente || {};
                const reserva = respuestaIA.datos_reserva || {};

                if (cliente.nombre && reserva.vehiculo) {
                    const folio = await guardarReservaEnExcel(cliente, reserva);
                    if (folio) {
                        respuestaFinal = respuestaFinal.replace("[FOLIO_AQUI]", `*${folio}*`);
                        sessionData.reservaGuardada = true;

                        // Inyectar amnesia forzada a la IA
                        historial.push({
                            role: "system",
                            content: "SISTEMA: La reserva se guardó. Misión cumplida. PROHIBIDO volver a ejecutar la acción 'guardar_reserva'. Si el usuario dice gracias, despídete y tu acción debe ser 'charlar'."
                        });
                        respuestaIA.accion = "charlar";
                    } else {
                        respuestaFinal = "⚠️ Tuvimos un pequeño problema técnico al generar el folio, pero un agente verificará tus datos pronto.";
                    }
                } else {
                    respuestaFinal = "Me faltó un dato. ¿Podrías confirmarme nuevamente tu nombre, las fechas y el auto?";
                    respuestaIA.accion = "charlar";
                }
            }
        }

        // ===============================
        // ACCIÓN: CANCELAR RESERVA
        // ===============================
        if (respuestaIA.accion === "cancelar_reserva") {
            if (sessionData.cancelacionRealizada) {
                respuestaFinal = "La cancelación ya fue procesada. ¿Puedo ayudarte en algo más?";
                respuestaIA.accion = "charlar";
            } else {
                const folioACancelar = respuestaIA.datos_reserva?.folio_a_cancelar || "";
                if (folioACancelar.length >= 4) {
                    const cancelado = await cancelarReservaEnExcel(folioACancelar);
                    if (cancelado) {
                        respuestaFinal = `🚫 La reserva con folio *${folioACancelar}* ha sido cancelada exitosamente. ¿Necesitas ayuda con algo más?`;
                        sessionData.cancelacionRealizada = true;

                        historial.push({
                            role: "system",
                            content: "SISTEMA: La cancelación se ejecutó. PROHIBIDO volver a usar 'cancelar_reserva'. Cambia tu acción a 'charlar'."
                        });
                        respuestaIA.accion = "charlar";
                    } else {
                        respuestaFinal = `⚠️ No pudimos cancelar el folio ${folioACancelar}. Verifica que esté bien escrito o contacta a soporte.`;
                    }
                } else {
                    respuestaFinal = "Por favor, indícame un folio válido para cancelar (ejemplo: AR-1234X).";
                }
            }
        }

        // Guardar respuesta en historial (con la acción posiblemente modificada)
        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({
            fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗.\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte\n\n¿En qué te ayudo hoy?"
        });
    }
});

// ===============================
// 🔹 HEALTH CHECK
// ===============================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        sesionesActivas: sesiones.size,
        autosEnCache: cacheAutos.data.length
    });
});

// ===============================
// 🚀 INICIAR SERVIDOR
// ===============================
app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🚗 AutoRent Chatbot - Producción    ║
╠════════════════════════════════════════╣
║ Puerto: ${port}
║ Catálogo: ${CATALOGO_URL}
║ API Key Groq: ${CLEAN_KEY ? '✅ Configurada' : '❌ Faltante'}
╚════════════════════════════════════════╝
    `);
});
