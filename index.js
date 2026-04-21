require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

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
    ttl: 10 * 60 * 1000
};

// ===============================
// 🔹 FUNCIÓN DE CORREO (HTML MEJORADO)
// ===============================
async function enviarCorreoConfirmacion(correoDestino, reserva, cliente, folio) {
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

        const nombreMostrar = cliente.nombre && cliente.nombre.trim() !== '' && !cliente.nombre.match(/\d{1,2}\/\d{1,2}\/\d{4}/) ? cliente.nombre : 'Cliente';

        const mailHTML = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;background:#f4f7fc;padding:20px}.container{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.08);overflow:hidden}.header{background:linear-gradient(135deg,#667eea,#764ba2);padding:30px;color:#fff;text-align:center}.content{padding:30px}.info-box{background:#f8fafc;border-left:6px solid #667eea;padding:20px;border-radius:12px;margin:20px 0}.folio{background:#eef2ff;padding:15px;border-radius:12px;text-align:center;font-size:20px;color:#4f46e5;font-weight:700}.footer{background:#f1f5f9;padding:20px;text-align:center;color:#64748b}</style></head>
        <body><div class="container"><div class="header"><h1>🚗 Reserva Confirmada</h1><p>AutoRent · Tu viaje comienza aquí</p></div>
        <div class="content"><p>¡Hola ${nombreMostrar}!</p><p>Tu reserva ha sido registrada exitosamente.</p>
        <div class="info-box"><p><strong>🚙 Vehículo:</strong> ${reserva.vehiculo}</p><p><strong>📅 Inicio:</strong> ${reserva.fecha_inicio}</p><p><strong>📅 Fin:</strong> ${reserva.fecha_fin}</p><p><strong>💰 Total:</strong> $${reserva.precio_total?.toLocaleString()}</p></div>
        <div class="folio">📋 Folio: ${folio}</div><p>Presenta este folio al recoger el vehículo. ¡Gracias!</p></div>
        <div class="footer">© AutoRent · Correo automático</div></div></body></html>`;

        await transporter.sendMail({
            from: `"AutoRent 🚗" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: `✅ Confirmación de Reserva - Folio: ${folio}`,
            html: mailHTML,
            text: `Hola ${nombreMostrar}, tu reserva (${folio}) para ${reserva.vehiculo} ha sido confirmada.`
        });

        console.log(`📧 Correo enviado a ${correoDestino}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        return false;
    }
}

// ===============================
// 🔹 OBTENER AUTOS (CON CACHÉ)
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
async function guardarReservaEnExcel(cliente, reserva) {
    try {
        const folio = `AR-${Date.now().toString(36).toUpperCase()}`;
        const registro = {
            Nombre: cliente.nombre || "Cliente",
            Telefono: cliente.telefono || "No proporcionado",
            Correo: cliente.correo,
            Modelo: reserva.vehiculo,
            Fecha_Inicio: reserva.fecha_inicio,
            Fecha_Fin: reserva.fecha_fin,
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
// 🔹 GENERAR LINK CATÁLOGO
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    if (preferencias.puertas) params.append('puertas', preferencias.puertas);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES MEJORADA
// ===============================
function inicializarSesion(sessionId) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, {
            historial: [],
            estado: 'inicio',
            preferencias: {},
            datosCliente: {},
            autoSeleccionado: null,
            lastActivity: Date.now()
        });
    }
    return sesiones.get(sessionId);
}

// Función para detectar si el texto es una despedida o saludo que debería reiniciar al menú
function esReinicio(texto) {
    const txt = texto.toLowerCase();
    const reinicios = ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'menú', 'menu', 'inicio', 'reiniciar', 'empezar', 'comenzar'];
    return reinicios.some(p => txt.includes(p));
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
        if (transmision) resultados = resultados.filter(a => a.transmision.toLowerCase().includes(transmision.toLowerCase()));
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
        const transmisiones = [...new Set(autos.map(a => a.transmision))].sort();
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
        const textoLimpio = queryText.toLowerCase().trim();
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos();
        const session = inicializarSesion(sessionId);
        
        // Extraer email y teléfono (pero NO nombre genérico)
        const emailMatch = queryText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) session.datosCliente.correo = emailMatch[0];
        const telefonoMatch = queryText.match(/\b\d{10,15}\b/);
        if (telefonoMatch) session.datosCliente.telefono = telefonoMatch[0];

        // Detectar si el usuario quiere reiniciar
        if (esReinicio(textoLimpio) && session.estado !== 'inicio') {
            session.estado = 'inicio';
            session.preferencias = {};
            session.autoSeleccionado = null;
            const menu = `¡Hola de nuevo! ¿Qué deseas hacer?\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo Completo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos para Rentar\n5️⃣ Soporte Técnico`;
            session.historial.push({ role: "assistant", content: menu });
            return res.json({ fulfillmentText: menu });
        }

        // MENÚ INICIAL
        if (session.estado === 'inicio' || !sesiones.has(sessionId)) {
            if (!sesiones.has(sessionId)) {
                session.estado = 'inicio';
            }
            
            if (textoLimpio === '1' || textoLimpio.includes('rentar')) {
                session.estado = 'preguntando_puertas';
                const resp = "Perfecto. Para recomendarte el auto ideal, necesito algunas preferencias:\n\n¿Cuántas puertas prefieres? (2, 4 o 5)";
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '2' || textoLimpio.includes('catálogo') || textoLimpio.includes('catalogo')) {
                const link = generarLink();
                const resp = `Puedes ver todos nuestros autos disponibles aquí:\n${link}`;
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '3' || textoLimpio.includes('cancelar')) {
                session.estado = 'cancelar_pedir_folio';
                const resp = "Por favor, indícame el folio de la reserva que deseas cancelar (ej: AR-1234X).";
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '4' || textoLimpio.includes('requisito')) {
                const resp = "📋 Requisitos para rentar:\n• INE/Pasaporte vigente\n• Licencia de conducir vigente\n• Tarjeta de crédito (garantía)\n• Mayor de 21 años";
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '5' || textoLimpio.includes('soporte')) {
                const resp = "Un agente se comunicará contigo a la brevedad. Por favor, compártenos tu número de WhatsApp.";
                return res.json({ fulfillmentText: resp });
            }
            else {
                const menu = `¡Hola! Bienvenido a AutoRent 🚗\n\n¿Qué deseas hacer hoy?\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo Completo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos para Rentar\n5️⃣ Soporte Técnico`;
                return res.json({ fulfillmentText: menu });
            }
        }

        // Permitir salir de cualquier estado con "menú" o similar
        if (textoLimpio === 'menu' || textoLimpio === 'menú' || textoLimpio === '0') {
            session.estado = 'inicio';
            const menu = `¿En qué más puedo ayudarte?\n1️⃣ Rentar auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte`;
            return res.json({ fulfillmentText: menu });
        }

        // Estados del flujo de renta
        if (session.estado === 'preguntando_puertas') {
            const match = queryText.match(/\b([2-5])\b/);
            if (match) {
                session.preferencias.puertas = parseInt(match[1]);
                session.estado = 'preguntando_asientos';
                const resp = `✅ ${session.preferencias.puertas} puertas.\n\n¿Cuántos asientos necesitas? (2, 4, 5, 7)`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: "Por favor, indícame el número de puertas (2, 4 o 5)." });
            }
        }

        if (session.estado === 'preguntando_asientos') {
            const match = queryText.match(/\b([2-9])\b/);
            if (match) {
                session.preferencias.pasajeros = parseInt(match[1]);
                session.estado = 'preguntando_transmision';
                const resp = `✅ ${session.preferencias.pasajeros} asientos.\n\n¿Qué tipo de transmisión prefieres? (Automática o Estándar)`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: "Por favor, indícame el número de asientos (2, 4, 5, 7)." });
            }
        }

        if (session.estado === 'preguntando_transmision') {
            let transmision = null;
            if (textoLimpio.includes('autom') || textoLimpio.includes('auto')) transmision = 'Automática';
            else if (textoLimpio.includes('estándar') || textoLimpio.includes('standard') || textoLimpio.includes('manual')) transmision = 'Estándar';
            
            if (transmision) {
                session.preferencias.transmision = transmision;
                
                const autosFiltrados = autos.filter(a => {
                    if (session.preferencias.puertas && a.puertas !== session.preferencias.puertas) return false;
                    if (session.preferencias.pasajeros && a.pasajeros < session.preferencias.pasajeros) return false;
                    if (session.preferencias.transmision && a.transmision !== session.preferencias.transmision) return false;
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
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: "¿Automática o Estándar?" });
            }
        }

        if (session.estado === 'esperando_modelo') {
            const autoEncontrado = autos.find(a => 
                queryText.toLowerCase().includes(a.modelo.toLowerCase()) || 
                queryText.toLowerCase().includes(a.marca.toLowerCase() + ' ' + a.modelo.toLowerCase())
            );
            
            if (autoEncontrado) {
                session.autoSeleccionado = autoEncontrado;
                
                if (!session.datosCliente.nombre || !session.datosCliente.correo || !session.datosCliente.telefono) {
                    session.estado = 'esperando_datos_contacto';
                    const resp = `Excelente elección: ${autoEncontrado.vehiculo}.\n\nPara continuar con la reserva, necesito tus datos:\n- Nombre completo\n- Correo electrónico\n- Teléfono de contacto\n\nPor favor, proporciónalos en un solo mensaje (ej: Juan Pérez, juan@mail.com, 5512345678).`;
                    return res.json({ fulfillmentText: resp });
                }
                
                session.estado = 'esperando_fechas';
                const resp = `Has seleccionado: ${autoEncontrado.vehiculo}.\n\nAhora necesito las fechas de renta:\n📅 Fecha de inicio (DD/MM/AAAA)\n📅 Fecha de fin (DD/MM/AAAA)\n\nEjemplo: 20/12/2024 al 25/12/2024`;
                return res.json({ fulfillmentText: resp });
            } else {
                const resp = `No encontré ese modelo. ¿Podrías verificarlo en el enlace y escribir el nombre exacto?`;
                return res.json({ fulfillmentText: resp });
            }
        }

        if (session.estado === 'esperando_datos_contacto') {
            // Intentar extraer nombre, email, teléfono del mensaje
            const emailMatchLocal = queryText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const telefonoMatchLocal = queryText.match(/\b\d{10,15}\b/);
            
            if (emailMatchLocal) session.datosCliente.correo = emailMatchLocal[0];
            if (telefonoMatchLocal) session.datosCliente.telefono = telefonoMatchLocal[0];
            
            // El resto del texto se considera nombre (si no tiene formato de fecha)
            let posibleNombre = queryText;
            if (emailMatchLocal) posibleNombre = posibleNombre.replace(emailMatchLocal[0], '');
            if (telefonoMatchLocal) posibleNombre = posibleNombre.replace(telefonoMatchLocal[0], '');
            posibleNombre = posibleNombre.replace(/[,.]/g, ' ').trim();
            
            // Si lo que queda parece una fecha, lo ignoramos
            if (!posibleNombre.match(/\d{1,2}\/\d{1,2}\/\d{4}/) && posibleNombre.length > 0) {
                session.datosCliente.nombre = posibleNombre;
            }
            
            if (session.datosCliente.correo && session.datosCliente.telefono && session.datosCliente.nombre) {
                session.estado = 'esperando_fechas';
                const resp = `Gracias ${session.datosCliente.nombre}. Ahora necesito las fechas de renta para el ${session.autoSeleccionado.vehiculo}:\n📅 Fecha de inicio (DD/MM/AAAA)\n📅 Fecha de fin (DD/MM/AAAA)`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: "Necesito nombre, correo y teléfono. Por favor, envíalos juntos (ej: Juan Pérez, juan@mail.com, 5512345678)." });
            }
        }

        if (session.estado === 'esperando_fechas') {
            const fechasMatch = queryText.match(/(\d{1,2}\/\d{1,2}\/\d{4}).*?(\d{1,2}\/\d{1,2}\/\d{4})/);
            if (fechasMatch) {
                const fechaInicio = fechasMatch[1];
                const fechaFin = fechasMatch[2];
                
                const inicio = new Date(fechaInicio.split('/').reverse().join('-'));
                const fin = new Date(fechaFin.split('/').reverse().join('-'));
                if (isNaN(inicio) || isNaN(fin) || fin <= inicio) {
                    return res.json({ fulfillmentText: "Fechas inválidas. Asegúrate de que la fecha fin sea posterior a la de inicio." });
                }
                
                const dias = Math.ceil((fin - inicio) / (1000 * 60 * 60 * 24));
                const total = dias * session.autoSeleccionado.precio;
                
                const cliente = {
                    nombre: session.datosCliente.nombre || "Cliente",
                    telefono: session.datosCliente.telefono || "0000000000",
                    correo: session.datosCliente.correo || "noemail@example.com"
                };
                const reserva = {
                    vehiculo: session.autoSeleccionado.vehiculo,
                    fecha_inicio: fechaInicio,
                    fecha_fin: fechaFin,
                    dias,
                    precio_total: total
                };
                
                const folio = await guardarReservaEnExcel(cliente, reserva);
                if (folio) {
                    let resp = `✅ ¡Reserva confirmada!\n\n`;
                    resp += `🚗 Vehículo: ${session.autoSeleccionado.vehiculo}\n`;
                    resp += `📅 Fechas: ${fechaInicio} al ${fechaFin}\n`;
                    resp += `⏱️ Días: ${dias}\n`;
                    resp += `💰 Total: $${total}\n`;
                    resp += `📋 Folio: ${folio}\n\n`;
                    resp += `Te hemos enviado los detalles a tu correo. ¡Gracias por elegir AutoRent!`;
                    
                    if (session.datosCliente.correo) {
                        await enviarCorreoConfirmacion(session.datosCliente.correo, reserva, cliente, folio);
                    }
                    
                    session.estado = 'inicio';
                    return res.json({ fulfillmentText: resp });
                } else {
                    return res.json({ fulfillmentText: "Hubo un error al guardar la reserva. Intenta de nuevo más tarde." });
                }
            } else {
                return res.json({ fulfillmentText: "Por favor, proporciona las fechas en formato DD/MM/AAAA al DD/MM/AAAA" });
            }
        }

        if (session.estado === 'cancelar_pedir_folio') {
            // Si el usuario escribe otra cosa que no es folio, volver al menú
            if (textoLimpio.match(/^ar-/i) || textoLimpio.match(/^[a-z0-9-]+$/i)) {
                const folio = queryText.trim().toUpperCase();
                const cancelado = await cancelarReservaEnExcel(folio);
                if (cancelado) {
                    session.estado = 'inicio';
                    return res.json({ fulfillmentText: `✅ Reserva ${folio} cancelada exitosamente. ¿Necesitas algo más?` });
                } else {
                    return res.json({ fulfillmentText: `No se pudo cancelar. Verifica el folio o escribe "menú" para volver.` });
                }
            } else {
                session.estado = 'inicio';
                return res.json({ fulfillmentText: "Entendido. Volvamos al menú.\n1️⃣ Rentar auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte" });
            }
        }

        // Respuesta por defecto si no hay estado reconocido
        const respDefault = "¿En qué más puedo ayudarte?\n1️⃣ Rentar auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte";
        return res.json({ fulfillmentText: respDefault });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO:", error);
        res.json({ fulfillmentText: "Lo siento, ocurrió un error. Por favor, escribe 'menú' para reiniciar." });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en puerto ${port}`);
});
