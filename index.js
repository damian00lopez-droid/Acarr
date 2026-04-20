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
// 🔹 FUNCIONES DE CORREO
// ===============================
async function enviarCorreoConfirmacion(correoDestino, reserva, cliente, folio) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("⚠️ No se enviará correo: Credenciales SMTP no configuradas");
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

        await transporter.sendMail({
            from: `"AutoRent" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: `🚗 Confirmación de Reserva - Folio: ${folio}`,
            text: `¡Hola ${cliente.nombre}!\n\nTu reserva ha sido confirmada exitosamente.\n\n🚗 Vehículo: ${reserva.vehiculo}\n📅 Fechas: ${reserva.fecha_inicio} al ${reserva.fecha_fin}\n📋 Folio: ${folio}\n\n¡Gracias por elegir AutoRent!`
        });
        console.log(`📧 Correo enviado a ${correoDestino}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        return false;
    }
}

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
    if (preferencias.puertas) params.append('puertas', preferencias.puertas);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES CON ESTADO
// ===============================
function inicializarSesion(sessionId) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, {
            historial: [],
            estado: 'inicio', // inicio, preguntando_puertas, preguntando_asientos, preguntando_transmision, esperando_modelo, esperando_fechas
            preferencias: {},
            datosCliente: {},
            autoSeleccionado: null,
            lastActivity: Date.now()
        });
    }
    return sesiones.get(sessionId);
}

// ===============================
// 🔹 PROMPT SISTEMA (Simplificado)
// ===============================
function generarPromptSistema() {
    return `Eres el asistente de AutoRent. El sistema ya maneja la lógica de renta paso a paso. Tu función es conversar naturalmente con el cliente basándote en el estado actual proporcionado en el contexto. NO inventes pasos extra. Sigue las indicaciones del sistema.`;
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
        const session = inicializarSesion(sessionId);
        
        // Extraer datos de contacto del mensaje (nombre, email, teléfono)
        const emailMatch = queryText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) session.datosCliente.correo = emailMatch[0];
        const telefonoMatch = queryText.match(/\b\d{10,15}\b/);
        if (telefonoMatch) session.datosCliente.telefono = telefonoMatch[0];
        // Nombre: podríamos usar IA o simplemente guardar lo que diga

        // 🔥 MENÚ INICIAL / REINICIO
        const palabrasMenu = ['hola', 'menú', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches', 'opciones', 'reiniciar'];
        if (!sesiones.has(sessionId) || palabrasMenu.includes(textoLimpio) || textoLimpio === '0') {
            session.estado = 'inicio';
            session.preferencias = {};
            session.autoSeleccionado = null;
            
            const menu = `¡Hola! Bienvenido a AutoRent 🚗\n\n¿Qué deseas hacer hoy?\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo Completo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos para Rentar\n5️⃣ Soporte Técnico`;
            
            session.historial = [{ role: "system", content: generarPromptSistema() }];
            session.historial.push({ role: "user", content: queryText });
            session.historial.push({ role: "assistant", content: menu });
            
            return res.json({ fulfillmentMessages: [{ text: { text: [menu] } }] });
        }

        // 🔥 MANEJO POR ESTADO (Lógica secuencial sin IA)
        if (session.estado === 'inicio') {
            // Opciones del menú
            if (textoLimpio === '1' || textoLimpio.includes('rentar')) {
                session.estado = 'preguntando_puertas';
                const resp = "Perfecto. Para recomendarte el auto ideal, necesito algunas preferencias:\n\n¿Cuántas puertas prefieres? (2, 4 o 5)";
                session.historial.push({ role: "assistant", content: resp });
                return res.json({ fulfillmentText: resp });
            }
            else if (textoLimpio === '2' || textoLimpio.includes('catálogo') || textoLimpio.includes('catalogo')) {
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
                // Intentar con IA para conversación general
                // (código de fallback con Groq, similar al existente)
            }
        }

        // Flujo de preferencias: puertas -> asientos -> transmisión
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
            const txt = textoLimpio;
            let transmision = null;
            if (txt.includes('autom') || txt.includes('auto')) transmision = 'Automática';
            else if (txt.includes('estándar') || txt.includes('standard') || txt.includes('manual')) transmision = 'Estándar';
            
            if (transmision) {
                session.preferencias.transmision = transmision;
                
                // Generar link con filtros
                const link = generarLink(session.preferencias);
                
                // También podemos filtrar autos para mostrar un resumen
                const autosFiltrados = autos.filter(a => {
                    if (session.preferencias.puertas && a.puertas !== session.preferencias.puertas) return false;
                    if (session.preferencias.pasajeros && a.pasajeros < session.preferencias.pasajeros) return false;
                    if (session.preferencias.transmision && a.transmision !== session.preferencias.transmision) return false;
                    return true;
                });
                
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

        // Esperando que el usuario escriba el modelo del auto
        if (session.estado === 'esperando_modelo') {
            // Buscar auto por nombre
            const autoEncontrado = autos.find(a => 
                queryText.toLowerCase().includes(a.modelo.toLowerCase()) || 
                queryText.toLowerCase().includes(a.marca.toLowerCase() + ' ' + a.modelo.toLowerCase())
            );
            
            if (autoEncontrado) {
                session.autoSeleccionado = autoEncontrado;
                session.estado = 'esperando_fechas';
                
                // Pedir datos de contacto si no los tenemos
                if (!session.datosCliente.nombre || !session.datosCliente.correo || !session.datosCliente.telefono) {
                    const resp = `Excelente elección: ${autoEncontrado.vehiculo}.\n\nPara continuar con la reserva, necesito tus datos:\n- Nombre completo\n- Correo electrónico\n- Teléfono de contacto\n\nPor favor, proporciónalos.`;
                    session.estado = 'esperando_datos_contacto';
                    session.historial.push({ role: "assistant", content: resp });
                    return res.json({ fulfillmentText: resp });
                } else {
                    const resp = `Has seleccionado: ${autoEncontrado.vehiculo}.\n\nAhora necesito las fechas de renta:\n📅 Fecha de inicio (DD/MM/AAAA)\n📅 Fecha de fin (DD/MM/AAAA)\n\nEjemplo: 20/12/2024 al 25/12/2024`;
                    session.historial.push({ role: "assistant", content: resp });
                    return res.json({ fulfillmentText: resp });
                }
            } else {
                const resp = `No encontré ese modelo en nuestro catálogo. ¿Podrías verificarlo en el enlace y escribir el nombre exacto?`;
                return res.json({ fulfillmentText: resp });
            }
        }

        // Datos de contacto
        if (session.estado === 'esperando_datos_contacto') {
            // Guardar datos
            session.datosCliente.nombre = queryText; // Simplificado
            session.estado = 'esperando_fechas';
            const resp = `Gracias. Ahora necesito las fechas de renta para el ${session.autoSeleccionado.vehiculo}:\n📅 Fecha de inicio (DD/MM/AAAA)\n📅 Fecha de fin (DD/MM/AAAA)`;
            return res.json({ fulfillmentText: resp });
        }

        // Fechas y reserva final
        if (session.estado === 'esperando_fechas') {
            const fechasMatch = queryText.match(/(\d{1,2}\/\d{1,2}\/\d{4}).*?(\d{1,2}\/\d{1,2}\/\d{4})/);
            if (fechasMatch) {
                const fechaInicio = fechasMatch[1];
                const fechaFin = fechasMatch[2];
                
                // Validación simple
                const inicio = new Date(fechaInicio.split('/').reverse().join('-'));
                const fin = new Date(fechaFin.split('/').reverse().join('-'));
                if (isNaN(inicio) || isNaN(fin) || fin <= inicio) {
                    return res.json({ fulfillmentText: "Fechas inválidas. Asegúrate de que la fecha fin sea posterior a la de inicio." });
                }
                
                const dias = Math.ceil((fin - inicio) / (1000 * 60 * 60 * 24));
                const total = dias * session.autoSeleccionado.precio;
                
                // Guardar reserva
                const cliente = {
                    nombre: session.datosCliente.nombre || "Cliente",
                    telefono: session.datosCliente.telefono || "0000000000",
                    correo: session.datosCliente.correo || "noemail@example.com"
                };
                const reserva = {
                    vehiculo: session.autoSeleccionado.vehiculo,
                    fecha_inicio: fechaInicio,
                    fecha_fin: fechaFin
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
                        await enviarCorreoConfirmacion(session.datosCliente.correo, {...reserva, dias, precio_total: total}, cliente, folio);
                    }
                    
                    session.estado = 'inicio'; // Reiniciar
                    return res.json({ fulfillmentText: resp });
                } else {
                    return res.json({ fulfillmentText: "Hubo un error al guardar la reserva. Intenta de nuevo más tarde." });
                }
            } else {
                return res.json({ fulfillmentText: "Por favor, proporciona las fechas en formato DD/MM/AAAA al DD/MM/AAAA" });
            }
        }

        // Cancelación
        if (session.estado === 'cancelar_pedir_folio') {
            const folio = queryText.trim().toUpperCase();
            const cancelado = await cancelarReservaEnExcel(folio);
            if (cancelado) {
                session.estado = 'inicio';
                return res.json({ fulfillmentText: `✅ Reserva ${folio} cancelada exitosamente.` });
            } else {
                return res.json({ fulfillmentText: `No se pudo cancelar. Verifica el folio.` });
            }
        }

        // Si no se manejó por estado, usar IA (fallback)
        // ... (código de Groq similar al original, pero con contexto del estado)
        
        // Respuesta por defecto
        return res.json({ fulfillmentText: "¿En qué más puedo ayudarte? (1 Rentar, 2 Catálogo, 3 Cancelar, 4 Requisitos, 5 Soporte)" });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "Lo siento, ocurrió un error. Por favor, intenta de nuevo." });
    }
});

// Endpoints para la API del catálogo
app.get('/api/autos', async (req, res) => {
    try {
        const autos = await obtenerAutos();
        let resultados = [...autos];
        
        const { tipo, marca, transmision, precio_max, pasajeros, puertas, search } = req.query;
        if (tipo) resultados = resultados.filter(a => a.tipo.toLowerCase().includes(tipo.toLowerCase()));
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
        const tipos = [...new Set(autos.map(a => a.tipo))].sort();
        const transmisiones = [...new Set(autos.map(a => a.transmision))].sort();
        res.json({ success: true, data: { marcas, tipos, transmisiones } });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error interno" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en puerto ${port}`);
});
