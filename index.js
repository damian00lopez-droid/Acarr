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
const CATALOGO_URL = "https://acarr-v3a2.onrender.com/catalogo.html";
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
    ttl: 10 * 60 * 1000
};

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        if (cacheAutos.data.length > 0 && cacheAutos.lastUpdate && (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            return cacheAutos.data;
        }

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
                transmision: a.Transmision || 'Automática'
            }));

        cacheAutos = { data: autosProcesados, lastUpdate: Date.now(), ttl: cacheAutos.ttl };
        return autosProcesados;
    } catch (error) {
        console.error("❌ Error catálogo:", error);
        return cacheAutos.data;
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

        if (res.ok) return folio;
        return null;
    } catch (error) {
        console.error("❌ Error guardando en Excel:", error);
        return null;
    }
}

async function cancelarReservaEnExcel(folio) {
    try {
        const updateResponse = await fetch(`${sheetdbUrl}/Folio/${folio}?sheet=Reservas`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: { Estado: 'Cancelada' }
            })
        });
        return updateResponse.ok;
    } catch (error) {
        console.error('❌ Error cancelando reserva:', error);
        return false;
    }
}

function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 PROMPT SISTEMA
// ===============================
function generarPromptSistema(autos) {
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente experto de AutoRent.

REGLAS DE ORO:
1. PROHIBIDO INVENTAR URLs: Usa EXACTAMENTE el texto "[LINK_AQUI]". El sistema lo reemplazará.
2. PROHIBIDO INVENTAR FOLIOS: Usa EXACTAMENTE el texto "[FOLIO_AQUI]". El sistema lo reemplazará.

PROCESO 1: RENTAR UN AUTO
- P1: Pregunta sus preferencias (Tipo de auto, pasajeros). Categorías disponibles: ${categoriasDisponibles}.
- P2: Pide Nombre, Correo y Teléfono.
- P3: Con datos y preferencias, cambia accion a "recomendar" y usa la etiqueta "[LINK_AQUI]". Pide que regrese a decirte el modelo.
- P4: Cuando te dé el modelo, pide las FECHAS.
- P5: Cuando tengas modelo y fechas, cambia accion a "guardar_reserva" y usa "[FOLIO_AQUI]" para confirmar.

OTROS PROCESOS:
- Catálogo: Dile "Aquí tienes nuestro catálogo: [LINK_AQUI]".
- Cancelar: Pide su Folio. Cuando lo dé, cambia a "cancelar_reserva".
- Requisitos: INE/Pasaporte, Licencia vigente, Tarjeta de Crédito, mayor de 21 años.
- Soporte: Pide su teléfono para WhatsApp.

FORMATO JSON OBLIGATORIO:
{
  "respuesta_usuario": "Tu mensaje usando [LINK_AQUI] o [FOLIO_AQUI] según corresponda...",
  "accion": "charlar" | "recomendar" | "guardar_reserva" | "cancelar_reserva",
  "datos_cliente": { "nombre": "", "correo": "", "telefono": "" },
  "datos_reserva": { "vehiculo": "", "fecha_inicio": "", "fecha_fin": "", "folio_a_cancelar": "" },
  "preferencias_detectadas": { "tipo": "", "marca": "", "transmision": "" }
}`;
}

function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    let historial = sesiones.get(sessionId);
    historial[0].content = promptSistema;
    
    if (historial.length > MAX_HISTORIAL) {
        historial = [historial[0], ...historial.slice(-MAX_HISTORIAL + 1)];
        sesiones.set(sessionId, historial);
    }
    return historial;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const textoLimpio = queryText.toLowerCase().trim();
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos(); 
        const promptSistema = generarPromptSistema(autos);
        
        // ==========================================
        // 🔥 INTERCEPTOR DEL MENÚ (BYPASS DE LA IA) 🔥
        // ==========================================
        const palabrasMenu = ['hola', 'menú', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches', 'opciones'];
        
        if (!sesiones.has(sessionId) || palabrasMenu.includes(textoLimpio)) {
            // Generamos la sesión si no existe
            gestionarSesion(sessionId, promptSistema);
            let historial = sesiones.get(sessionId);

            // Texto estricto del menú desde Node.js
            const menuExacto = `¡Hola! Bienvenido a AutoRent 🚗. ¿Qué deseas hacer hoy?\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo Completo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos para Rentar\n5️⃣ Soporte Técnico`;

            // Le inyectamos esto al historial de la IA para que sepa lo que le dijimos al usuario
            historial.push({ role: "user", content: queryText });
            historial.push({ 
                role: "assistant", 
                content: JSON.stringify({ respuesta_usuario: menuExacto, accion: "charlar", datos_cliente: {}, datos_reserva: {}, preferencias_detectadas: {} }) 
            });

            // Retornamos directamente sin gastar tokens ni preguntar a Groq
            return res.json({ fulfillmentMessages: [{ text: { text: [menuExacto] } }] });
        }
        // ==========================================

        const historial = gestionarSesion(sessionId, promptSistema);
        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // ACCIÓN: RECOMENDAR
        if (respuestaIA.accion === "recomendar" || respuestaFinal.includes("[LINK_AQUI]")) {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            respuestaFinal = respuestaFinal.replace("[LINK_AQUI]", linkSeguro);
        }

        // ACCIÓN: GUARDAR RESERVA
        if (respuestaIA.accion === "guardar_reserva") {
            const cliente = respuestaIA.datos_cliente || {};
            const reserva = respuestaIA.datos_reserva || {};
            
            if (cliente.nombre && reserva.vehiculo) {
                const folio = await guardarReservaEnExcel(cliente, reserva);
                if (folio) {
                    respuestaFinal = respuestaFinal.replace("[FOLIO_AQUI]", `*${folio}*`);
                    historial.push({
                        role: "system",
                        content: "La reserva se guardó. PROHIBIDO usar 'guardar_reserva' de nuevo. Cambia a 'charlar'."
                    });
                    respuestaIA.accion = "charlar"; 
                    respuestaIA.datos_reserva = {}; 
                } else {
                    respuestaFinal = "⚠️ Tuvimos un problema al generar el folio, un agente lo revisará.";
                }
            } else {
                respuestaFinal = "Me faltó un dato. ¿Podrías confirmarme tu nombre, las fechas y el auto?";
                respuestaIA.accion = "charlar";
            }
        }

        // ACCIÓN: CANCELAR RESERVA
        if (respuestaIA.accion === "cancelar_reserva") {
            const folioACancelar = respuestaIA.datos_reserva?.folio_a_cancelar || "";
            
            if (folioACancelar.length >= 4) {
                const cancelado = await cancelarReservaEnExcel(folioACancelar);
                if (cancelado) {
                    respuestaFinal = `🚫 La reserva con folio *${folioACancelar}* ha sido cancelada exitosamente. ¿Necesitas algo más?`;
                } else {
                    respuestaFinal = `⚠️ No pudimos cancelar el folio ${folioACancelar}. Verifica que esté bien escrito.`;
                }
                historial.push({
                    role: "system",
                    content: "La cancelación se ejecutó. PROHIBIDO usar 'cancelar_reserva' de nuevo. Cambia a 'charlar'."
                });
                respuestaIA.accion = "charlar";
                respuestaIA.datos_reserva.folio_a_cancelar = "";
            } else {
                respuestaFinal = "Por favor, indícame un folio válido para cancelar (ejemplo: AR-1234X).";
            }
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗.\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
});
