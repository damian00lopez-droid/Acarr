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
const MAX_HISTORIAL = 14; // Aumentamos para mantener contexto del usuario

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
        // Actualiza el Estado a 'Cancelada' usando la API PATCH de SheetDB por Folio
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

// ===============================
// 🔹 GENERADOR DE LINK
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES & PROMPT
// ===============================
function generarPromptSistema(autos) {
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente experto de AutoRent. Eres profesional, amigable y usas emojis.
URL del catálogo: ${CATALOGO_URL}
Categorías disponibles hoy: ${categoriasDisponibles || 'Sedan, SUV, Familiar, Económico'}

MENÚ PRINCIPAL Y REGLAS:
Si el usuario te saluda, no sabe qué hacer, o pide el menú, MUESTRA ESTAS OPCIONES EXACTAS:
1️⃣ Rentar un Auto
2️⃣ Ver Catálogo Completo
3️⃣ Cancelar Reserva
4️⃣ Requisitos para Rentar
5️⃣ Soporte Técnico

FLUJO ESTRICTO PARA "RENTAR UN AUTO" (Opción 1):
- PASO 1 (Preferencias): Pregúntale qué busca. Ej: "¿Para cuántas personas? ¿Prefieres un auto económico, un SUV o un Sedan? ¿Automático o estándar?".
- PASO 2 (Datos): Cuando te diga sus preferencias, dile que tienes excelentes opciones, pero primero pide su Nombre, Correo y Teléfono.
- PASO 3 (Sugerencias -> accion: "recomendar"): Ya con sus datos y preferencias, cambia tu acción a "recomendar". Dile "Con base en tus preferencias, te sugiero revisar este enlace:" y pídele que regrese a decirte el MODELO EXACTO que eligió.
- PASO 4 (Fechas): Cuando te dé el modelo, pregúntale las FECHAS (inicio y fin).
- PASO 5 (Confirmar -> accion: "guardar_reserva"): Cuando tengas modelo y fechas, cambia tu acción a "guardar_reserva".

OTRAS OPCIONES:
- Catálogo (Opción 2): Envíale la URL base.
- Cancelar (Opción 3): Pide su Folio (ej. AR-12345). Cuando lo tengas, cambia la acción a "cancelar_reserva".
- Requisitos (Opción 4): INE/Pasaporte, Licencia vigente, Tarjeta de Crédito (garantía) y ser mayor de 21 años.
- Soporte (Opción 5): Pide su teléfono y dile que un asesor lo contactará por WhatsApp.

REGLA DE ORO ANTI-LOOP: NUNCA repitas las acciones "guardar_reserva" ni "cancelar_reserva" en turnos consecutivos. Si el usuario dice "Gracias", tu acción debe ser "charlar".

FORMATO JSON OBLIGATORIO:
{
  "respuesta_usuario": "Tu texto para el cliente...",
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
// 🚀 WEBHOOK PRINCIPAL (CON IA)
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos(); 
        const promptSistema = generarPromptSistema(autos);
        const historial = gestionarSesion(sessionId, promptSistema);
        
        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // ACCIÓN: RECOMENDAR (Links filtrados)
        if (respuestaIA.accion === "recomendar") {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            if (respuestaFinal.includes(CATALOGO_URL)) {
                respuestaFinal = respuestaFinal.replace(CATALOGO_URL, linkSeguro);
            } else {
                respuestaFinal += `\n\n🔗 Opciones recomendadas para ti: ${linkSeguro}`;
            }
        }

        // ACCIÓN: GUARDAR RESERVA (Excel)
        if (respuestaIA.accion === "guardar_reserva") {
            const cliente = respuestaIA.datos_cliente || {};
            const reserva = respuestaIA.datos_reserva || {};
            
            if (cliente.nombre && reserva.vehiculo) {
                const folio = await guardarReservaEnExcel(cliente, reserva);
                if (folio) {
                    respuestaFinal += `\n\n✅ ¡Hemos registrado tu reserva con éxito! Tu folio de confirmación es: *${folio}*.`;
                    // 🛡️ Seguro Anti-Loop
                    respuestaIA.accion = "charlar"; 
                    respuestaIA.datos_reserva = {}; 
                } else {
                    respuestaFinal += `\n\n⚠️ Tuvimos un pequeño problema técnico, pero un agente verificará tus datos pronto.`;
                }
            } else {
                respuestaFinal = "Me faltó un dato. ¿Podrías confirmarme nuevamente tu nombre, las fechas y el auto?";
            }
        }

        // ACCIÓN: CANCELAR RESERVA (Excel)
        if (respuestaIA.accion === "cancelar_reserva") {
            const folioACancelar = respuestaIA.datos_reserva?.folio_a_cancelar || "";
            
            if (folioACancelar.length > 4) { // Validar que parece un folio
                const cancelado = await cancelarReservaEnExcel(folioACancelar);
                if (cancelado) {
                    respuestaFinal += `\n\n🚫 La reserva con folio *${folioACancelar}* ha sido cancelada exitosamente en nuestro sistema.`;
                } else {
                    respuestaFinal += `\n\n⚠️ No pudimos cancelar el folio ${folioACancelar}. Verifica que esté bien escrito o contacta a soporte.`;
                }
                // 🛡️ Seguro Anti-Loop
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
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗.\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte\n\n¿En qué te ayudo hoy?" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
});
