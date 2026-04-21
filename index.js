require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

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
// 🔹 FUNCIÓN PARA ELIMINAR ACENTOS
// ===============================
function eliminarAcentos(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ===============================
// 🔹 FUNCIÓN DE CORREO (CON MAPS)
// ===============================
async function enviarCorreoConfirmacion(correoDestino, reserva, cliente, folio, direccion) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("⚠️ Credenciales SMTP no configuradas.");
        return false;
    }

    try {
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(direccion)}`;

        const mailHTML = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;background:#f4f7fc;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden}.header{background:linear-gradient(135deg,#667eea,#764ba2);padding:30px;color:#fff;text-align:center}.content{padding:30px}.info-box{background:#f8fafc;border-left:6px solid #667eea;padding:20px;border-radius:12px;margin:20px 0}.folio{background:#eef2ff;padding:15px;border-radius:12px;text-align:center;font-size:20px;color:#4f46e5;font-weight:700}.footer{background:#f1f5f9;padding:20px;text-align:center;color:#64748b}a{color:#667eea;font-weight:600;text-decoration:none}</style></head>
        <body><div class="container"><div class="header"><h1>🚗 Reserva Confirmada</h1><p>AutoRent · Tu viaje comienza aquí</p></div>
        <div class="content"><p>¡Hola ${cliente.nombre || 'Cliente'}!</p><p>Tu reserva ha sido registrada exitosamente.</p>
        <div class="info-box"><p><strong>🚙 Vehículo:</strong> ${reserva.vehiculo}</p><p><strong>📅 Inicio:</strong> ${reserva.fecha_inicio}</p><p><strong>📅 Fin:</strong> ${reserva.fecha_fin}</p><p><strong>💰 Total:</strong> $${reserva.precio_total?.toLocaleString()}</p></div>
        <div class="folio">📋 Folio: ${folio}</div>
        <p><strong>📍 Dirección de entrega:</strong> ${direccion}</p>
        <p><a href="${mapsLink}">🗺️ Ver en Google Maps</a></p>
        <p>Presenta este folio y tu identificación al recoger el vehículo. ¡Gracias!</p></div>
        <div class="footer">© AutoRent · Correo automático</div></div></body></html>`;

        await transporter.sendMail({
            from: `"AutoRent 🚗" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: `✅ Confirmación de Reserva - Folio: ${folio}`,
            html: mailHTML,
            text: `Hola ${cliente.nombre}, tu reserva (${folio}) para ${reserva.vehiculo} ha sido confirmada. Dirección: ${direccion}. Fechas: ${reserva.fecha_inicio} - ${reserva.fecha_fin}.`
        });

        console.log(`📧 Correo enviado a ${correoDestino}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        return false;
    }
}

// ===============================
// 🔹 OBTENER AUTOS (CACHÉ)
// ===============================
async function obtenerAutos() {
    try {
        if (cacheAutos.data.length && cacheAutos.lastUpdate && (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            return cacheAutos.data;
        }

        const res = await fetch(sheetdbUrl);
        if (!res.ok) throw new Error(`SheetDB ${res.status}`);
        
        const data = await res.json();
        const autosProcesados = data
            .filter(a => a.Disponibilidad === 'Disponible' || a.Disponibilidad === 'DISPONIBLE')
            .map(a => ({
                id: a.ID_Auto || `${a.Marca}-${a.Modelo}`.toLowerCase().replace(/\s+/g, '-'),
                marca: a.Marca || '',
                modelo: a.Modelo || '',
                vehiculo: `${a.Marca} ${a.Modelo}`,
                precio: parseFloat(a.Precio_Por_Dia) || 0,
                tipo: a.Categoria || a.Tipo || 'Sedan',
                transmision: a.Transmision || 'Automática',
                puertas: parseInt(a.Puertas) || 4,
                pasajeros: parseInt(a.Asientos) || 5,
                año: a.Anio || '2024',
                imagen: a.Imagen || ''
            }));

        cacheAutos = { data: autosProcesados, lastUpdate: Date.now(), ttl: cacheAutos.ttl };
        return autosProcesados;
    } catch (error) {
        console.error("❌ Error catálogo:", error);
        return cacheAutos.data;
    }
}

// ===============================
// 🔹 GUARDAR / CANCELAR EN EXCEL
// ===============================
async function guardarReservaEnExcel(cliente, reserva, direccion) {
    try {
        const folio = `AR-${Date.now().toString(36).toUpperCase()}`;
        const registro = {
            Nombre: cliente.nombre,
            Telefono: cliente.telefono || "No proporcionado",
            Correo: cliente.correo,
            Modelo: reserva.vehiculo,
            Fecha_Inicio: reserva.fecha_inicio,
            Fecha_Fin: reserva.fecha_fin,
            Direccion: direccion,
            Folio: folio,
            Estado: 'Confirmado'
        };
        const res = await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [registro] })
        });
        return res.ok ? folio : null;
    } catch (error) {
        console.error("❌ Error guardando:", error);
        return null;
    }
}

async function cancelarReservaEnExcel(folio) {
    try {
        const updateResponse = await fetch(`${sheetdbUrl}/Folio/${folio}?sheet=Reservas`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { Estado: 'Cancelada' } })
        });
        return updateResponse.ok;
    } catch (error) {
        console.error('❌ Error cancelando:', error);
        return false;
    }
}

// ===============================
// 🔹 GENERAR LINK CATÁLOGO (SIN ACENTOS)
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.marca) params.append('marca', preferencias.marca);
    
    // Transmisión sin acentos y en minúsculas
    if (preferencias.transmision) {
        const transmisionNormalizada = eliminarAcentos(preferencias.transmision).toLowerCase();
        params.append('transmision', transmisionNormalizada);
    }
    
    if (preferencias.puertas) params.append('puertas', preferencias.puertas);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES
// ===============================
function inicializarSesion(sessionId) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, {
            historial: [],
            estado: 'inicio',
            preferencias: {},
            datosCliente: {},
            autoSeleccionado: null,
            direccionEntrega: null,
            lastActivity: Date.now()
        });
    }
    return sesiones.get(sessionId);
}

// ===============================
// 🔹 IA PARA PREGUNTAS ABIERTAS
// ===============================
async function responderConIA(session, queryText) {
    try {
        const promptSistema = `Eres el asistente de AutoRent. Responde de manera útil y breve. Si el usuario pregunta sobre requisitos y no tiene INE, sugiere pasaporte o licencia. No inventes funciones.`;

        const messages = [
            { role: "system", content: promptSistema },
            ...session.historial.slice(-6),
            { role: "user", content: queryText }
        ];

        const completion = await groq.chat.completions.create({
            messages,
            model: "llama-3.1-8b-instant",
            temperature: 0.3,
            max_tokens: 200
        });

        const respuesta = completion.choices[0].message.content.trim();
        session.historial.push({ role: "assistant", content: respuesta });
        return respuesta;
    } catch (error) {
        console.error("Error con IA:", error);
        return "Lo siento, no entendí. ¿Puedes reformular?";
    }
}

// ===============================
// 🔹 ENDPOINTS API
// ===============================
app.get('/api/autos', async (req, res) => {
    try {
        const autos = await obtenerAutos();
        let resultados = [...autos];
        const { marca, transmision, precio_max, pasajeros, puertas, search } = req.query;
        
        if (marca) resultados = resultados.filter(a => a.marca.toLowerCase().includes(marca.toLowerCase()));
        
        // Filtrar por transmisión sin acentos
        if (transmision) {
            const transmisionNormalizada = eliminarAcentos(transmision).toLowerCase();
            resultados = resultados.filter(a => eliminarAcentos(a.transmision).toLowerCase() === transmisionNormalizada);
        }
        
        if (precio_max) resultados = resultados.filter(a => a.precio <= parseFloat(precio_max));
        if (pasajeros) resultados = resultados.filter(a => a.pasajeros >= parseInt(pasajeros));
        if (puertas) resultados = resultados.filter(a => a.puertas == parseInt(puertas));
        if (search) {
            resultados = resultados.filter(a => 
                a.vehiculo.toLowerCase().includes(search.toLowerCase()) ||
                a.marca.toLowerCase().includes(search.toLowerCase()) ||
                a.modelo.toLowerCase().includes(search.toLowerCase())
            );
        }
        res.json({ success: true, total: resultados.length, data: resultados });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error interno" });
    }
});

app.get('/api/metadata', async (req, res) => {
    try {
        const autos = await obtenerAutos();
        const marcas = [...new Set(autos.map(a => a.marca))].sort();
        const transmisiones = [...new Set(autos.map(a => eliminarAcentos(a.transmision)))] // sin acentos
            .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()) // capitalizar
            .sort();
        res.json({ success: true, data: { marcas, transmisiones } });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error interno" });
    }
});

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const textoLimpio = eliminarAcentos(queryText.toLowerCase().trim());
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos();
        const session = inicializarSesion(sessionId);
        
        // Extraer datos de contacto
        const emailMatch = queryText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) session.datosCliente.correo = emailMatch[0];
        const telefonoMatch = queryText.match(/\b\d{10,15}\b/);
        if (telefonoMatch) session.datosCliente.telefono = telefonoMatch[0];
        
        if (!emailMatch && !telefonoMatch && !queryText.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) {
            const palabras = queryText.split(/[\s,]+/);
            if (palabras.length >= 2 && palabras[0].length > 2) {
                session.datosCliente.nombre = palabras.slice(0, 2).join(' ');
            } else {
                session.datosCliente.nombre = queryText;
            }
        }

        // MENÚ INICIAL / REINICIO
        const palabrasMenu = ['hola', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches', 'opciones', 'reiniciar', 'buenas'];
        if (!sesiones.has(sessionId) || palabrasMenu.includes(textoLimpio) || textoLimpio === '0') {
            session.estado = 'inicio';
            session.preferencias = {};
            session.autoSeleccionado = null;
            session.direccionEntrega = null;
            
            const menu = `¡Hola! Bienvenido a AutoRent 🚗\n\n¿Qué deseas hacer hoy?\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo Completo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos para Rentar\n5️⃣ Soporte Técnico`;
            
            session.historial = [{ role: "system", content: "Eres el asistente de AutoRent." }];
            session.historial.push({ role: "user", content: queryText });
            session.historial.push({ role: "assistant", content: menu });
            
            return res.json({ fulfillmentMessages: [{ text: { text: [menu] } }] });
        }

        // MANEJO POR ESTADO
        if (session.estado === 'inicio') {
            if (textoLimpio === '1' || textoLimpio.includes('rentar')) {
                session.estado = 'preguntando_puertas';
                const resp = "Perfecto. Para recomendarte el auto ideal, necesito algunas preferencias:\n\n¿Cuántas puertas prefieres? (2, 4 o 5)";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '2' || textoLimpio.includes('catalogo')) {
                const link = generarLink();
                const resp = `Puedes ver todos nuestros autos disponibles aquí:\n${link}`;
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '3' || textoLimpio.includes('cancelar')) {
                session.estado = 'cancelar_pedir_folio';
                const resp = "Por favor, indícame el folio de la reserva que deseas cancelar (ej: AR-1234X).";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '4' || textoLimpio.includes('requisito')) {
                const resp = "📋 Requisitos para rentar:\n• INE/Pasaporte vigente\n• Licencia de conducir vigente\n• Tarjeta de crédito (garantía)\n• Mayor de 21 años";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '5' || textoLimpio.includes('soporte')) {
                const resp = "Un agente se comunicará contigo a la brevedad. Por favor, compártenos tu número de WhatsApp.";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else {
                const respuestaIA = await responderConIA(session, queryText);
                return res.json({ fulfillmentText: respuestaIA });
            }
        }

        // Flujo de preferencias
        if (session.estado === 'preguntando_puertas') {
            const match = queryText.match(/\b([2-5])\b/);
            if (match) {
                session.preferencias.puertas = parseInt(match[1]);
                session.estado = 'preguntando_asientos';
                const resp = `✅ ${session.preferencias.puertas} puertas.\n\n¿Cuántos asientos necesitas? (2, 4, 5, 7)`;
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            } else {
                const resp = "Por favor, indícame el número de puertas (2, 4 o 5).";
                return res.json({ fulfillmentText: resp });
            }
        }

        if (session.estado === 'preguntando_asientos') {
            const match = queryText.match(/\b([2-9])\b/);
            if (match) {
                session.preferencias.pasajeros = parseInt(match[1]);
                session.estado = 'preguntando_transmision';
                const resp = `✅ ${session.preferencias.pasajeros} asientos.\n\n¿Qué tipo de transmisión prefieres? (Automática o Estándar)`;
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            } else {
                const resp = "Por favor, indícame el número de asientos (2, 4, 5, 7).";
                return res.json({ fulfillmentText: resp });
            }
        }

        if (session.estado === 'preguntando_transmision') {
            let transmision = null;
            // Detectar sin acentos
            if (textoLimpio.includes('automatica') || textoLimpio.includes('auto')) transmision = 'Automática';
            else if (textoLimpio.includes('estandar') || textoLimpio.includes('manual')) transmision = 'Estándar';
            
            if (transmision) {
                session.preferencias.transmision = transmision;
                
                const autosFiltrados = autos.filter(a => {
                    if (session.preferencias.puertas && a.puertas !== session.preferencias.puertas) return false;
                    if (session.preferencias.pasajeros && a.pasajeros < session.preferencias.pasajeros) return false;
                    // Comparar transmisión sin acentos
                    if (session.preferencias.transmision && eliminarAcentos(a.transmision).toLowerCase() !== eliminarAcentos(session.preferencias.transmision).toLowerCase()) return false;
                    return true;
                });
                
                const link = generarLink(session.preferencias);
                
                let resp = `🎯 ¡Preferencias guardadas!\n\n`;
                resp += `• Puertas: ${session.preferencias.puertas}\n`;
                resp += `• Asientos: ${session.preferencias.pasajeros}\n`;
                resp += `• Transmisión: ${session.preferencias.transmision}\n\n`;
                
                if (autosFiltrados.length > 0) {
                    resp += `✅ Encontré ${autosFiltrados.length} vehículos que coinciden.\n\n`;
                    resp += `🔗 **Ver catálogo filtrado:**\n${link}\n\n`;
                    resp += `Cuando hayas elegido un modelo, regresa al chat y escríbeme el nombre exacto del auto (ej: "Toyota Corolla").`;
                } else {
                    resp += `😅 No hay coincidencias exactas. Te muestro el catálogo completo:\n${link}\n\nSelecciona el que más te guste y dime el modelo.`;
                }
                
                session.estado = 'esperando_modelo';
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            } else {
                const resp = "¿Automática o Estándar?";
                return res.json({ fulfillmentText: resp });
            }
        }

        // Resto del flujo (esperando_modelo, esperando_datos_contacto, esperando_fechas, esperando_direccion, cancelar_pedir_folio)
        // ... (MANTENER EL CÓDIGO EXACTAMENTE IGUAL QUE EN LA RESPUESTA ANTERIOR)
        // [Aquí va el mismo código de la respuesta anterior para esos estados]

        // Fallback IA
        const respuestaIA = await responderConIA(session, queryText);
        return res.json({ fulfillmentText: respuestaIA });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "Lo siento, ocurrió un error. Por favor, intenta de nuevo." });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en puerto ${port}`);
    console.log(`📁 Archivos estáticos servidos desde /public`);
    console.log(`🔗 Catálogo: ${CATALOGO_URL}`);
});
