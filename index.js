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
const SOPORTE_WHATSAPP = "https://wa.me/5215532875527"; // Número de soporte

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
// 🔹 CORREO ELECTRÓNICO (HTML + MAPS + TRANSFERENCIA)
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
        const clabe = "638180010085123365";

        const mailHTML = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;background:#f4f7fc;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden}.header{background:linear-gradient(135deg,#667eea,#764ba2);padding:30px;color:#fff;text-align:center}.content{padding:30px}.info-box{background:#f8fafc;border-left:6px solid #667eea;padding:20px;border-radius:12px;margin:20px 0}.folio{background:#eef2ff;padding:15px;border-radius:12px;text-align:center;font-size:20px;color:#4f46e5;font-weight:700}.footer{background:#f1f5f9;padding:20px;text-align:center;color:#64748b}a{color:#667eea;font-weight:600;text-decoration:none}.documentos{background:#fff3cd;border-left:6px solid #ffc107;padding:15px;border-radius:12px;margin:20px 0}.pago{background:#d1e7dd;border-left:6px solid #198754;padding:15px;border-radius:12px;margin:20px 0}</style></head>
        <body><div class="container"><div class="header"><h1>🚗 Reserva Confirmada</h1><p>AutoRent · Tu viaje comienza aquí</p></div>
        <div class="content"><p>¡Hola ${cliente.nombre || 'Cliente'}!</p><p>Tu reserva ha sido registrada exitosamente.</p>
        <div class="info-box"><p><strong>🚙 Vehículo:</strong> ${reserva.vehiculo}</p><p><strong>📅 Inicio:</strong> ${reserva.fecha_inicio}</p><p><strong>📅 Fin:</strong> ${reserva.fecha_fin}</p><p><strong>💰 Total a pagar:</strong> $${reserva.precio_total?.toLocaleString()}</p></div>
        <div class="folio">📋 Folio: ${folio}</div>
        <p><strong>📍 Dirección de entrega:</strong> ${direccion}</p>
        <p><a href="${mapsLink}">🗺️ Ver en Google Maps</a></p>
        <div class="pago">
            <p><strong>💳 FORMA DE PAGO:</strong></p>
            <p>Para completar tu reserva, realiza una transferencia bancaria por el monto total a la siguiente CLABE:</p>
            <p style="font-size:22px;font-weight:bold;background:#fff;padding:10px;border-radius:8px;text-align:center;margin:10px 0">${clabe}</p>
            <p>Banco: <strong>Banorte</strong><br>
            Beneficiario: <strong>AutoRent S.A. de C.V.</strong></p>
            <p>Una vez realizada la transferencia, envía el comprobante a este mismo correo.</p>
        </div>
        <div class="documentos">
            <p><strong>📄 DOCUMENTOS REQUERIDOS:</strong></p>
            <p>Antes de la fecha de entrega, por favor envía a este correo:</p>
            <ul>
                <li>✅ INE o Pasaporte vigente (por ambos lados)</li>
                <li>✅ Licencia de conducir vigente</li>
            </ul>
        </div>
        <p>Presenta este folio y tu identificación al recoger el vehículo. ¡Gracias!</p></div>
        <div class="footer">© AutoRent · Correo automático</div></div></body></html>`;

        await transporter.sendMail({
            from: `"AutoRent 🚗" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: `✅ Confirmación de Reserva - Folio: ${folio}`,
            html: mailHTML,
            text: `Hola ${cliente.nombre}, tu reserva (${folio}) para ${reserva.vehiculo} ha sido confirmada. Dirección: ${direccion}. Total a transferir: $${reserva.precio_total} a la CLABE ${clabe}. Documentos requeridos: INE, licencia.`
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
            datosCliente: { nombre: null, correo: null, telefono: null },
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
        const transmisiones = [...new Set(autos.map(a => eliminarAcentos(a.transmision)))]
            .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
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
        
        // ===== EXTRACCIÓN DE DATOS DE CONTACTO =====
        if (session.estado === 'esperando_datos_contacto') {
            const regexContacto = /([a-zA-ZáéíóúñÁÉÍÓÚÑ\s]+?)[,\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[,\s]+(\d{10,15})/i;
            const match = queryText.match(regexContacto);
            
            if (match) {
                session.datosCliente.nombre = match[1].trim();
                session.datosCliente.correo = match[2].trim();
                session.datosCliente.telefono = match[3].trim();
            } else {
                const emailMatch = queryText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                const telefonoMatch = queryText.match(/\b\d{10,15}\b/);
                let nombreExtraido = queryText
                    .replace(emailMatch?.[0] || '', '')
                    .replace(telefonoMatch?.[0] || '', '')
                    .replace(/[,;]/g, ' ')
                    .trim();
                if (emailMatch) session.datosCliente.correo = emailMatch[0];
                if (telefonoMatch) session.datosCliente.telefono = telefonoMatch[0];
                if (nombreExtraido) session.datosCliente.nombre = nombreExtraido;
            }
        }

        // MENÚ INICIAL / REINICIO
        const palabrasMenu = ['hola', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches', 'opciones', 'reiniciar', 'buenas'];
        if (!sesiones.has(sessionId) || palabrasMenu.includes(textoLimpio) || textoLimpio === '0') {
            session.estado = 'inicio';
            session.preferencias = {};
            session.autoSeleccionado = null;
            session.direccionEntrega = null;
            session.datosCliente = { nombre: null, correo: null, telefono: null };
            
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
                session.estado = 'mostrando_requisitos';
                const resp = "📋 Requisitos para rentar:\n• INE/Pasaporte vigente\n• Licencia de conducir vigente\n• Pago mediante transferencia bancaria (CLABE: 638180010085123365)\n• Mayor de 21 años\n\n¿Te gustaría rentar un auto ahora? (Responde 'Sí' o 'No')";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '5' || textoLimpio.includes('soporte')) {
                // Soporte: enlace directo a WhatsApp
                const resp = `📞 Contáctanos por WhatsApp para soporte inmediato:\n${SOPORTE_WHATSAPP}\n\nUn agente te atenderá en breve.`;
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else {
                const respuestaIA = await responderConIA(session, queryText);
                return res.json({ fulfillmentText: respuestaIA });
            }
        }

        // FLUJO DE REQUISITOS
        if (session.estado === 'mostrando_requisitos') {
            if (textoLimpio.includes('si') || textoLimpio === 'sí' || textoLimpio === 'yes') {
                session.estado = 'preguntando_puertas';
                const resp = "Perfecto. Para recomendarte el auto ideal, necesito algunas preferencias:\n\n¿Cuántas puertas prefieres? (2, 4 o 5)";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            } else {
                session.estado = 'inicio';
                const resp = "Entendido. Cuando estés listo, puedes decir 'rentar' o '1'.\n¿Qué deseas hacer?";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
        }

        // PREGUNTANDO PUERTAS
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

        // PREGUNTANDO ASIENTOS
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

        // PREGUNTANDO TRANSMISIÓN
        if (session.estado === 'preguntando_transmision') {
            let transmision = null;
            if (textoLimpio.includes('automatica') || textoLimpio.includes('auto')) transmision = 'Automática';
            else if (textoLimpio.includes('estandar') || textoLimpio.includes('manual')) transmision = 'Estándar';
            
            if (transmision) {
                session.preferencias.transmision = transmision;
                
                const autosFiltrados = autos.filter(a => {
                    if (session.preferencias.puertas && a.puertas !== session.preferencias.puertas) return false;
                    if (session.preferencias.pasajeros && a.pasajeros < session.preferencias.pasajeros) return false;
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

        // ESPERANDO MODELO
        if (session.estado === 'esperando_modelo') {
            const autoEncontrado = autos.find(a => 
                queryText.toLowerCase().includes(a.modelo.toLowerCase()) || 
                queryText.toLowerCase().includes(a.marca.toLowerCase() + ' ' + a.modelo.toLowerCase())
            );
            
            if (autoEncontrado) {
                session.autoSeleccionado = autoEncontrado;
                session.estado = 'esperando_datos_contacto';
                session.datosCliente = { nombre: null, correo: null, telefono: null };
                
                const resp = `Excelente elección: ${autoEncontrado.vehiculo}.\n\nPara continuar con la reserva, necesito tus datos:\n- Nombre completo\n- Correo electrónico\n- Teléfono de contacto\n\nPor favor, proporciónalos en un solo mensaje (ej: Juan Pérez, juan@mail.com, 5512345678).`;
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            } else {
                const resp = `No encontré ese modelo. ¿Podrías verificarlo en el catálogo? ${generarLink(session.preferencias)}`;
                return res.json({ fulfillmentText: resp });
            }
        }

        // ESPERANDO DATOS DE CONTACTO
        if (session.estado === 'esperando_datos_contacto') {
            if (session.datosCliente.nombre && session.datosCliente.correo && session.datosCliente.telefono) {
                session.estado = 'esperando_fechas';
                const resp = `Gracias ${session.datosCliente.nombre}. Ahora necesito las fechas de renta para el ${session.autoSeleccionado.vehiculo}:\n📅 Fecha de inicio (DD/MM/AAAA)\n📅 Fecha de fin (DD/MM/AAAA)`;
                return res.json({ fulfillmentText: resp });
            } else {
                const resp = "Necesito nombre, correo y teléfono. Por favor, envíalos juntos (ej: Juan Pérez, juan@mail.com, 5512345678).";
                return res.json({ fulfillmentText: resp });
            }
        }

        // ESPERANDO FECHAS
        if (session.estado === 'esperando_fechas') {
            const fechasMatch = queryText.match(/(\d{1,2}\/\d{1,2}\/\d{4}).*?(\d{1,2}\/\d{1,2}\/\d{4})/);
            if (fechasMatch) {
                const fechaInicioStr = fechasMatch[1];
                const fechaFinStr = fechasMatch[2];
                
                function esFechaValida(dia, mes, anio) {
                    const fecha = new Date(anio, mes - 1, dia);
                    return fecha.getFullYear() === anio && fecha.getMonth() === mes - 1 && fecha.getDate() === dia;
                }
                
                const [diaI, mesI, anioI] = fechaInicioStr.split('/').map(Number);
                const [diaF, mesF, anioF] = fechaFinStr.split('/').map(Number);
                
                if (!esFechaValida(diaI, mesI, anioI) || !esFechaValida(diaF, mesF, anioF)) {
                    return res.json({ fulfillmentText: "❌ Alguna de las fechas no es válida (día/mes incorrecto). Por favor, verifica." });
                }
                
                const inicio = new Date(anioI, mesI - 1, diaI);
                const fin = new Date(anioF, mesF - 1, diaF);
                const hoy = new Date();
                hoy.setHours(0, 0, 0, 0);
                
                if (inicio < hoy) {
                    return res.json({ fulfillmentText: "❌ La fecha de inicio no puede ser anterior a hoy." });
                }
                if (fin <= inicio) {
                    return res.json({ fulfillmentText: "❌ La fecha de fin debe ser posterior a la de inicio." });
                }
                
                session.reserva = {
                    vehiculo: session.autoSeleccionado.vehiculo,
                    fecha_inicio: fechaInicioStr,
                    fecha_fin: fechaFinStr,
                    dias: Math.ceil((fin - inicio) / (1000 * 60 * 60 * 24))
                };
                session.reserva.precio_total = session.reserva.dias * session.autoSeleccionado.precio;
                
                session.estado = 'esperando_direccion';
                const resp = `Perfecto. Por último, ¿cuál es la dirección donde quieres recibir el vehículo? (Calle, número, ciudad)`;
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: "Por favor, proporciona las fechas en formato DD/MM/AAAA al DD/MM/AAAA" });
            }
        }

        // ESPERANDO DIRECCIÓN (confirmación de reserva - solo correo)
        if (session.estado === 'esperando_direccion') {
            session.direccionEntrega = queryText;
            
            const cliente = {
                nombre: session.datosCliente.nombre || "Cliente",
                telefono: session.datosCliente.telefono || "0000000000",
                correo: session.datosCliente.correo || "noemail@example.com"
            };
            
            const folio = await guardarReservaEnExcel(cliente, session.reserva, session.direccionEntrega);
            if (folio) {
                let resp = `✅ ¡Reserva confirmada!\n\n`;
                resp += `🚗 Vehículo: ${session.reserva.vehiculo}\n`;
                resp += `📅 Fechas: ${session.reserva.fecha_inicio} al ${session.reserva.fecha_fin}\n`;
                resp += `⏱️ Días: ${session.reserva.dias}\n`;
                resp += `💰 Total: $${session.reserva.precio_total}\n`;
                resp += `📍 Dirección: ${session.direccionEntrega}\n`;
                resp += `📋 Folio: ${folio}\n\n`;
                resp += `Te hemos enviado los detalles a tu correo. ¡Gracias por elegir AutoRent!`;
                
                // Solo correo, nada de WhatsApp
                if (session.datosCliente.correo) {
                    await enviarCorreoConfirmacion(session.datosCliente.correo, session.reserva, cliente, folio, session.direccionEntrega);
                }
                
                session.estado = 'inicio';
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: "Hubo un error al guardar la reserva. Intenta de nuevo más tarde." });
            }
        }

        // CANCELACIÓN (solo actualiza en Excel, sin WhatsApp)
        if (session.estado === 'cancelar_pedir_folio') {
            const folio = queryText.trim().toUpperCase();
            const cancelado = await cancelarReservaEnExcel(folio);
            if (cancelado) {
                session.estado = 'inicio';
                return res.json({ fulfillmentText: `✅ Reserva ${folio} cancelada exitosamente. Se ha actualizado el estado en nuestro sistema.` });
            } else {
                return res.json({ fulfillmentText: `No se pudo cancelar. Verifica el folio.` });
            }
        }

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
    console.log(`📞 Soporte WhatsApp: ${SOPORTE_WHATSAPP}`);
});
