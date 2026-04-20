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

// ===============================
// 🔥 CONFIGURACIÓN - ¡IMPORTANTE!
// ===============================
// CAMBIA ESTO POR TU URL REAL DE RENDER
const CATALOGO_URL = process.env.CATALOGO_URL || "https://acarr-v3a2.onrender.com/catalogo.html";
const MAX_HISTORIAL = 8;
const MAX_RESPONSE_TOKENS = 400;

// Cache de autos
let cacheAutos = {
    data: [],
    resumen: "",
    lastUpdate: null,
    ttl: 10 * 60 * 1000
};

// ===============================
// 🔥 VALIDACIÓN API KEY
// ===============================
const RAW_KEY = process.env.GROQ_API_KEY || "";
const CLEAN_KEY = RAW_KEY.trim();

if (!CLEAN_KEY) {
    console.error("❌ ERROR: GROQ_API_KEY no encontrada");
    process.exit(1);
}

const groq = new Groq({ apiKey: CLEAN_KEY });
const sesiones = new Map();

// Limpieza de sesiones
setInterval(() => {
    const ahora = Date.now();
    let limpiadas = 0;
    
    for (const [sessionId, data] of sesiones.entries()) {
        if (data.lastActivity && (ahora - data.lastActivity) > 60 * 60 * 1000) {
            sesiones.delete(sessionId);
            limpiadas++;
        }
    }
    
    if (limpiadas > 0) {
        console.log(`🧹 ${limpiadas} sesiones limpiadas`);
    }
}, 30 * 60 * 1000);

// ===============================
// 🔹 CACHÉ DE AUTOS
// ===============================
async function obtenerAutos(forceRefresh = false) {
    try {
        if (!forceRefresh &&
            cacheAutos.data.length > 0 &&
            cacheAutos.lastUpdate &&
            (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            return cacheAutos.data;
        }

        console.log("🔄 Actualizando catálogo...");
        const res = await fetch(sheetdbUrl);
        if (!res.ok) throw new Error(`SheetDB ${res.status}`);
        
        const data = await res.json();
        const autosProcesados = data
            .filter(a => a.Disponibilidad === 'Disponible' || a.Disponibilidad === 'DISPONIBLE')
            .map(a => ({
                id: (a.ID_Auto || `${a.Marca}-${a.Modelo}`).toLowerCase().replace(/\s+/g, '-'),
                marca: a.Marca || '',
                modelo: a.Modelo || '',
                vehiculo: `${a.Marca} ${a.Modelo}`,
                precio: parseFloat(a.Precio_Por_Dia) || 0,
                tipo: a.Categoria || a.Tipo || 'Sedan',
                transmision: a.Transmision || 'Automática',
                puertas: a.Puertas || '4',
                pasajeros: a.Asientos || a.Pasajeros || '5',
                año: a.Año || '2024'
            }));

        cacheAutos = {
            data: autosProcesados,
            lastUpdate: Date.now(),
            ttl: cacheAutos.ttl
        };

        console.log(`✅ ${autosProcesados.length} autos en caché`);
        return autosProcesados;
        
    } catch (error) {
        console.error("❌ Error catálogo:", error.message);
        return cacheAutos.data.length ? cacheAutos.data : [];
    }
}

// ===============================
// 🔹 API ENDPOINTS
// ===============================
app.get('/api/autos', async (req, res) => {
    try {
        const autos = await obtenerAutos();
        let resultados = [...autos];
        
        const { tipo, marca, transmision, precio_max, pasajeros, puertas, search } = req.query;
        
        if (tipo) resultados = resultados.filter(a => a.tipo.toLowerCase().includes(tipo.toLowerCase()));
        if (marca) resultados = resultados.filter(a => a.marca.toLowerCase().includes(marca.toLowerCase()));
        if (transmision) resultados = resultados.filter(a => a.transmision.toLowerCase().includes(transmision.toLowerCase()));
        if (precio_max) resultados = resultados.filter(a => a.precio <= parseFloat(precio_max));
        if (pasajeros) resultados = resultados.filter(a => parseInt(a.pasajeros) >= parseInt(pasajeros));
        if (puertas) resultados = resultados.filter(a => parseInt(a.puertas) == parseInt(puertas));
        if (search) {
            resultados = resultados.filter(a => 
                a.vehiculo.toLowerCase().includes(search.toLowerCase()) ||
                a.marca.toLowerCase().includes(search.toLowerCase()) ||
                a.modelo.toLowerCase().includes(search.toLowerCase())
            );
        }
        
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const start = (page - 1) * limit;
        
        res.json({
            success: true,
            total: resultados.length,
            data: resultados.slice(start, start + limit)
        });
        
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
        
        res.json({
            success: true,
            data: { marcas, tipos, transmisiones }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "Error interno" });
    }
});

// ===============================
// 🔹 FUNCIONES DE DETECCIÓN
// ===============================
function extraerDatosContacto(texto) {
    const datos = { nombre: null, email: null, telefono: null };
    
    const emailMatch = texto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) datos.email = emailMatch[0];
    
    const telefonoMatch = texto.match(/\b\d{10,15}\b/);
    if (telefonoMatch) datos.telefono = telefonoMatch[0];
    
    const palabras = texto.split(/[\s,]+/);
    for (let i = 0; i < palabras.length - 1; i++) {
        if (palabras[i].match(/^[A-Z][a-záéíóúñ]+$/) && 
            palabras[i+1].match(/^[A-Z][a-záéíóúñ]+$/)) {
            datos.nombre = `${palabras[i]} ${palabras[i+1]}`;
            break;
        }
    }
    
    return datos;
}

function detectarTipoVehiculo(texto) {
    const txt = texto.toLowerCase();
    if (txt.includes('económico') || txt.includes('economico')) return 'Económico';
    if (txt.includes('sedan') || txt.includes('sedán')) return 'Sedan';
    if (txt.includes('suv')) return 'SUV';
    if (txt.includes('lujo')) return 'Lujo';
    if (txt.includes('camioneta')) return 'Camioneta';
    if (txt.includes('deportivo')) return 'Deportivo';
    return null;
}

function detectarTransmision(texto) {
    const txt = texto.toLowerCase();
    if (txt.includes('automática') || txt.includes('automatica') || txt.includes('auto')) return 'Automática';
    if (txt.includes('estándar') || txt.includes('standard') || txt.includes('manual')) return 'Estándar';
    return null;
}

function detectarPuertas(texto) {
    const match = texto.match(/\b([2-5])\s*(puertas?)?\b/);
    if (match) return parseInt(match[1]);
    return null;
}

function detectarPasajeros(texto) {
    const match = texto.match(/\b([2-9])\s*(pasajeros?|personas?)\b/);
    if (match) return parseInt(match[1]);
    
    const numeros = texto.match(/\d+/);
    if (numeros) {
        const num = parseInt(numeros[0]);
        if (num >= 2 && num <= 9) return num;
    }
    return null;
}

function detectarUso(texto) {
    const txt = texto.toLowerCase();
    if (txt.includes('ciudad') || txt.includes('urbano')) return 'Ciudad';
    if (txt.includes('carretera') || txt.includes('viaje') || txt.includes('largo')) return 'Carretera';
    if (txt.includes('mixto') || txt.includes('ambos')) return 'Mixto';
    return null;
}

function detectarConfirmacion(texto) {
    const txt = texto.toLowerCase();
    return txt.includes('sí') || txt.includes('si') || 
           txt.includes('sip') || txt.includes('claro') || 
           txt.includes('ok') || txt.includes('dale') ||
           txt.includes('quiero rentar') || txt.includes('rentar');
}

function buscarAutoPorNombre(texto, autos) {
    const txt = texto.toLowerCase();
    
    // Buscar por modelo exacto
    for (const auto of autos) {
        if (txt.includes(auto.modelo.toLowerCase()) || 
            txt.includes(auto.marca.toLowerCase())) {
            return auto;
        }
    }
    
    // Buscar por palabras clave
    const palabras = txt.split(/\s+/);
    for (const auto of autos) {
        for (const palabra of palabras) {
            if (palabra.length > 3 && (
                auto.modelo.toLowerCase().includes(palabra) ||
                auto.marca.toLowerCase().includes(palabra)
            )) {
                return auto;
            }
        }
    }
    
    return null;
}

function filtrarAutosCompleto(autos, preferencias) {
    return autos.filter(auto => {
        if (preferencias.tipo && auto.tipo !== preferencias.tipo) return false;
        if (preferencias.transmision && auto.transmision !== preferencias.transmision) return false;
        if (preferencias.puertas && parseInt(auto.puertas) !== preferencias.puertas) return false;
        if (preferencias.pasajeros && parseInt(auto.pasajeros) < preferencias.pasajeros) return false;
        if (preferencias.precio_max && auto.precio > preferencias.precio_max) return false;
        return true;
    });
}

// ===============================
// 🔹 VALIDACIONES
// ===============================
function validarDatosRapido(datos) {
    const errores = [];
    if (datos.telefono && !/^\d{10,15}$/.test(String(datos.telefono).replace(/\D/g, ''))) {
        errores.push('Teléfono inválido (10 dígitos)');
    }
    if (datos.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo)) {
        errores.push('Email inválido');
    }
    return errores;
}

function validarFechas(fechaInicio, fechaFin) {
    try {
        const inicio = new Date(fechaInicio);
        const fin = new Date(fechaFin);
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        
        return !isNaN(inicio) && !isNaN(fin) && inicio >= hoy && fin > inicio;
    } catch {
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
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    if (preferencias.puertas) params.append('puertas', preferencias.puertas);
    params.append('ref', 'chat');
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 ENVÍOS
// ===============================
async function enviarWhatsApp(numero, mensaje) {
    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;
    if (!instanceId || !token) return false;

    try {
        const numeroLimpio = String(numero).replace(/\D/g, '');
        if (numeroLimpio.length < 10) return false;
        
        const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
        const params = new URLSearchParams({ token, to: numeroLimpio, body: mensaje.substring(0, 900) });
        
        const response = await fetch(url, { method: 'POST', body: params });
        return response.ok;
    } catch {
        return false;
    }
}

async function enviarCorreo(email, reserva, cliente, folio) {
    if (!process.env.SMTP_USER) return false;
    
    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        
        await transporter.sendMail({
            from: `"AutoRent" <${process.env.SMTP_USER}>`,
            to: email,
            subject: `Reserva Confirmada #${folio}`,
            text: `${cliente.nombre}, reserva confirmada: ${reserva.vehiculo} | ${reserva.fecha_inicio}-${reserva.fecha_fin} | Total: $${reserva.precio_total}`
        });
        return true;
    } catch {
        return false;
    }
}

async function guardarReserva(datosCliente, datosReserva) {
    try {
        const folio = `AR${Date.now().toString(36).toUpperCase()}`;
        const registro = {
            Folio: folio,
            Nombre: datosCliente.nombre,
            Telefono: datosCliente.telefono,
            Email: datosCliente.correo,
            Vehiculo: datosReserva.vehiculo,
            Fecha_inicio: datosReserva.fecha_inicio,
            Fecha_fin: datosReserva.fecha_fin,
            Dias: datosReserva.dias,
            Total: datosReserva.precio_total,
            Estado: 'Confirmada',
            Fecha_reserva: new Date().toISOString().split('T')[0]
        };
        
        await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [registro] })
        });
        
        return folio;
    } catch (error) {
        console.error("Error guardando:", error);
        return null;
    }
}

async function cancelarReserva(folio) {
    try {
        const response = await fetch(`${sheetdbUrl}/search?sheet=Reservas&Folio=${folio}`);
        const data = await response.json();
        
        if (!data || data.length === 0) {
            return { success: false, message: 'No se encontró la reserva' };
        }
        
        const updateResponse = await fetch(`${sheetdbUrl}/Folio/${folio}?sheet=Reservas`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: {
                    Estado: 'Cancelada',
                    Fecha_Cancelacion: new Date().toISOString().split('T')[0]
                }
            })
        });
        
        if (!updateResponse.ok) {
            throw new Error('Error al actualizar');
        }
        
        return { success: true, message: 'Reserva cancelada exitosamente' };
        
    } catch (error) {
        console.error('Error cancelando reserva:', error);
        return { success: false, message: 'Error al procesar la cancelación' };
    }
}

// ===============================
// 🔹 GESTIÓN DE SESIONES
// ===============================
function gestionarSesion(sessionId) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, {
            historial: [],
            datosUsuario: null,
            lastActivity: Date.now(),
            estado: 'inicio',
            preferencias: {
                tipo: null,
                transmision: null,
                puertas: null,
                pasajeros: null,
                precio_max: null,
                uso: null
            },
            autoSeleccionado: null,
            esperandoConfirmacion: false
        });
    }
    
    const sessionData = sesiones.get(sessionId);
    sessionData.lastActivity = Date.now();
    
    return sessionData;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL - CORREGIDO
// ===============================
app.post('/webhook', async (req, res) => {
    console.log(`📨 Webhook recibido - ${new Date().toISOString()}`);
    
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos();
        
        if (autos.length === 0) {
            return res.json({ 
                fulfillmentText: "Catálogo no disponible. Intenta más tarde." 
            });
        }

        const sessionData = gestionarSesion(sessionId);
        const texto = queryText.toLowerCase().trim();
        
        // PRIMERA INTERACCIÓN
        if (sessionData.historial.length === 0) {
            const bienvenida = `¡Bienvenido a AutoRent! 🚗\n\nProporcióname:\n• Nombre completo\n• Email\n• WhatsApp (10 dígitos)\n\nOpciones:\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva\n4️⃣ Requisitos\n5️⃣ Soporte`;
            
            sessionData.historial.push({ role: "user", content: queryText });
            sessionData.historial.push({ role: "assistant", content: bienvenida });
            sessionData.estado = 'menu_principal';
            
            return res.json({ fulfillmentText: bienvenida });
        }
        
        // EXTRAER DATOS DE CONTACTO
        const datosExtraidos = extraerDatosContacto(queryText);
        if (datosExtraidos.nombre || datosExtraidos.email || datosExtraidos.telefono) {
            sessionData.datosUsuario = {
                nombre: datosExtraidos.nombre || sessionData.datosUsuario?.nombre,
                correo: datosExtraidos.email || sessionData.datosUsuario?.correo,
                telefono: datosExtraidos.telefono || sessionData.datosUsuario?.telefono
            };
        }
        
        // SI ESTÁ ESPERANDO CONFIRMACIÓN DE AUTO
        if (sessionData.esperandoConfirmacion && sessionData.autoSeleccionado) {
            if (detectarConfirmacion(texto)) {
                sessionData.esperandoConfirmacion = false;
                sessionData.estado = 'solicitando_fechas';
                
                const auto = sessionData.autoSeleccionado;
                const resp = `✅ ¡Excelente elección!\n\nHas seleccionado: ${auto.vehiculo}\n• Precio: $${auto.precio}/día\n• Transmisión: ${auto.transmision}\n• Puertas: ${auto.puertas}\n• Pasajeros: ${auto.pasajeros}\n\nPara completar la reserva, necesito:\n📅 Fecha de inicio (DD/MM/AAAA)\n📅 Fecha de fin (DD/MM/AAAA)\n\nEjemplo: 25/12/2024 al 30/12/2024`;
                
                return res.json({ fulfillmentText: resp });
            } else {
                sessionData.esperandoConfirmacion = false;
                sessionData.autoSeleccionado = null;
                sessionData.estado = 'menu_principal';
                
                const resp = `Entendido. ¿Qué deseas hacer?\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva`;
                return res.json({ fulfillmentText: resp });
            }
        }
        
        // SOLICITANDO FECHAS PARA RESERVA
        if (sessionData.estado === 'solicitando_fechas' && sessionData.autoSeleccionado) {
            const fechasMatch = texto.match(/(\d{1,2}\/\d{1,2}\/\d{4}).*?(\d{1,2}\/\d{1,2}\/\d{4})/);
            
            if (fechasMatch) {
                const fechaInicio = fechasMatch[1];
                const fechaFin = fechasMatch[2];
                
                if (validarFechas(fechaInicio, fechaFin)) {
                    const inicio = new Date(fechaInicio.split('/').reverse().join('-'));
                    const fin = new Date(fechaFin.split('/').reverse().join('-'));
                    const dias = Math.ceil((fin - inicio) / (1000 * 60 * 60 * 24));
                    const total = dias * sessionData.autoSeleccionado.precio;
                    
                    // Guardar reserva
                    const datosCliente = sessionData.datosUsuario || {
                        nombre: 'Cliente',
                        telefono: '0000000000',
                        correo: 'cliente@email.com'
                    };
                    
                    const datosReserva = {
                        vehiculo: sessionData.autoSeleccionado.vehiculo,
                        fecha_inicio: fechaInicio,
                        fecha_fin: fechaFin,
                        dias: dias,
                        precio_total: total
                    };
                    
                    const folio = await guardarReserva(datosCliente, datosReserva);
                    
                    if (folio) {
                        // Enviar notificaciones
                        if (datosCliente.telefono !== '0000000000') {
                            enviarWhatsApp(datosCliente.telefono, 
                                `✅ Reserva #${folio}\n${datosReserva.vehiculo}\n${fechaInicio}-${fechaFin}\nTotal: $${total}`
                            ).catch(console.error);
                        }
                        
                        if (datosCliente.correo !== 'cliente@email.com') {
                            enviarCorreo(datosCliente.correo, datosReserva, datosCliente, folio)
                                .catch(console.error);
                        }
                        
                        sessionData.estado = 'menu_principal';
                        sessionData.autoSeleccionado = null;
                        
                        const resp = `✅ ¡RESERVA CONFIRMADA!\n\n📋 Folio: ${folio}\n🚗 Vehículo: ${datosReserva.vehiculo}\n📅 ${fechaInicio} al ${fechaFin}\n⏱️ ${dias} días\n💰 Total: $${total}\n\nTe enviamos los detalles por WhatsApp y correo.\n\n¿Necesitas algo más?\n1️⃣ Rentar otro auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva`;
                        
                        return res.json({ fulfillmentText: resp });
                    } else {
                        return res.json({ fulfillmentText: "❌ Error al guardar reserva. Intenta de nuevo." });
                    }
                } else {
                    return res.json({ fulfillmentText: "❌ Fechas inválidas. La fecha de inicio debe ser hoy o posterior, y la fecha fin después del inicio.\nEjemplo: 25/12/2024 al 30/12/2024" });
                }
            } else {
                return res.json({ fulfillmentText: "Por favor, proporciona las fechas en formato: DD/MM/AAAA al DD/MM/AAAA\nEjemplo: 25/12/2024 al 30/12/2024" });
            }
        }
        
        // MANEJO DE MENÚ PRINCIPAL
        if (texto.match(/^[1-5]$/) || sessionData.estado === 'menu_principal') {
            const opcion = texto.match(/^[1-5]$/) ? parseInt(texto) : null;
            
            if (opcion === 1 || texto.includes('rentar') || texto.includes('alquilar')) {
                sessionData.estado = 'preguntando_tipo';
                sessionData.preferencias = {
                    tipo: null,
                    transmision: null,
                    puertas: null,
                    pasajeros: null,
                    precio_max: null,
                    uso: null
                };
                
                const resp = `¡Iniciemos con tu renta! 🚗\n\nPara recomendarte las mejores opciones, necesito conocer tus preferencias:\n\n¿Qué tipo de vehículo prefieres?\n• Económico\n• Sedan\n• SUV\n• Lujo\n• Camioneta`;
                return res.json({ fulfillmentText: resp });
            }
            
            if (opcion === 2 || texto.includes('catálogo') || texto.includes('catalogo')) {
                const link = generarLink(sessionData.preferencias);
                const resp = `🔗 Aquí está nuestro catálogo:\n${link}\n\nCuando encuentres un auto que te guste, dime el modelo para continuar.`;
                return res.json({ fulfillmentText: resp });
            }
            
            if (opcion === 3 || texto.includes('cancelar')) {
                sessionData.estado = 'esperando_folio';
                const resp = `Para cancelar una reserva, necesito el folio de confirmación (ej: AR123ABC). ¿Podrías proporcionármelo?`;
                return res.json({ fulfillmentText: resp });
            }
            
            if (opcion === 4 || texto.includes('requisito')) {
                const resp = `📋 **Requisitos para rentar:**\n• INE/Pasaporte vigente\n• Licencia de conducir vigente\n• Tarjeta de crédito (garantía)\n• Mayor de 21 años\n\n¿Deseas rentar un auto? Responde "1" para comenzar.`;
                return res.json({ fulfillmentText: resp });
            }
            
            if (opcion === 5 || texto.includes('soporte')) {
                const nombre = sessionData.datosUsuario?.nombre?.split(' ')[0] || '';
                const resp = `${nombre ? '¡Gracias ' + nombre + '! ' : ''}Un agente te contactará en 5-15 minutos al WhatsApp proporcionado. ¿Puedo ayudarte con algo más?`;
                return res.json({ fulfillmentText: resp });
            }
        }
        
        // CANCELACIÓN DE RESERVA
        if (sessionData.estado === 'esperando_folio') {
            const folio = queryText.trim().toUpperCase();
            
            if (folio.match(/^AR[A-Z0-9]+$/)) {
                const resultado = await cancelarReserva(folio);
                
                if (resultado.success) {
                    sessionData.estado = 'menu_principal';
                    const resp = `✅ Reserva ${folio} cancelada exitosamente.\n\n¿Necesitas algo más?\n1️⃣ Rentar auto\n2️⃣ Ver catálogo`;
                    return res.json({ fulfillmentText: resp });
                } else {
                    return res.json({ fulfillmentText: `❌ ${resultado.message}. Intenta de nuevo.` });
                }
            } else {
                return res.json({ fulfillmentText: `❌ Folio inválido. Debe ser como AR123ABC.` });
            }
        }
        
        // PREGUNTAS SECUENCIALES
        if (sessionData.estado === 'preguntando_tipo') {
            const tipoDetectado = detectarTipoVehiculo(texto);
            
            if (tipoDetectado) {
                sessionData.preferencias.tipo = tipoDetectado;
                sessionData.estado = 'preguntando_transmision';
                
                const resp = `✅ ${tipoDetectado}\n\n¿Qué transmisión prefieres?\n• Automática\n• Estándar`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `Por favor, selecciona un tipo:\n• Económico\n• Sedan\n• SUV\n• Lujo\n• Camioneta` });
            }
        }
        
        if (sessionData.estado === 'preguntando_transmision') {
            const transmisionDetectada = detectarTransmision(texto);
            
            if (transmisionDetectada) {
                sessionData.preferencias.transmision = transmisionDetectada;
                sessionData.estado = 'preguntando_puertas';
                
                const resp = `✅ ${transmisionDetectada}\n\n¿Cuántas puertas necesitas?\n• 2\n• 4\n• 5`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `¿Automática o Estándar?` });
            }
        }
        
        if (sessionData.estado === 'preguntando_puertas') {
            const puertasDetectadas = detectarPuertas(texto);
            
            if (puertasDetectadas) {
                sessionData.preferencias.puertas = puertasDetectadas;
                sessionData.estado = 'preguntando_pasajeros';
                
                const resp = `✅ ${puertasDetectadas} puertas\n\n¿Para cuántos pasajeros?\n• 2\n• 4\n• 5\n• 7`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `¿2, 4 o 5 puertas?` });
            }
        }
        
        if (sessionData.estado === 'preguntando_pasajeros') {
            const pasajerosDetectados = detectarPasajeros(texto);
            
            if (pasajerosDetectados) {
                sessionData.preferencias.pasajeros = pasajerosDetectados;
                sessionData.estado = 'preguntando_presupuesto';
                
                const resp = `✅ ${pasajerosDetectados} pasajeros\n\n¿Cuál es tu presupuesto máximo por día? (en pesos MXN)`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `¿Para cuántas personas? (2, 4, 5, 7)` });
            }
        }
        
        if (sessionData.estado === 'preguntando_presupuesto') {
            const numeros = texto.match(/\d+/g);
            
            if (numeros) {
                const presupuesto = parseInt(numeros[0]);
                sessionData.preferencias.precio_max = presupuesto;
                sessionData.estado = 'preguntando_uso';
                
                const resp = `✅ $${presupuesto} por día\n\n¿Qué uso le darás al vehículo?\n• Ciudad\n• Carretera/Viaje\n• Mixto`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `¿Cuánto quieres gastar por día? (ejemplo: 500)` });
            }
        }
        
        if (sessionData.estado === 'preguntando_uso') {
            const usoDetectado = detectarUso(texto);
            
            if (usoDetectado) {
                sessionData.preferencias.uso = usoDetectado;
                
                const autosFiltrados = filtrarAutosCompleto(autos, sessionData.preferencias);
                const link = generarLink(sessionData.preferencias);
                
                let respuesta = `🎯 **TUS PREFERENCIAS:**\n`;
                respuesta += `• Tipo: ${sessionData.preferencias.tipo}\n`;
                respuesta += `• Transmisión: ${sessionData.preferencias.transmision}\n`;
                respuesta += `• Puertas: ${sessionData.preferencias.puertas}\n`;
                respuesta += `• Pasajeros: ${sessionData.preferencias.pasajeros}\n`;
                respuesta += `• Presupuesto: $${sessionData.preferencias.precio_max}/día\n`;
                respuesta += `• Uso: ${sessionData.preferencias.uso}\n\n`;
                
                if (autosFiltrados.length > 0) {
                    respuesta += `✅ **${autosFiltrados.length} opciones disponibles:**\n\n`;
                    
                    autosFiltrados.slice(0, 3).forEach(auto => {
                        respuesta += `🚗 **${auto.vehiculo}**\n   💰 $${auto.precio}/día | ⚙️ ${auto.transmision} | 🚪 ${auto.puertas}p | 👥 ${auto.pasajeros} pas\n\n`;
                    });
                    
                    if (autosFiltrados.length > 3) {
                        respuesta += `📊 Y ${autosFiltrados.length - 3} opciones más...\n`;
                    }
                    
                    respuesta += `\n🔗 **Ver catálogo completo filtrado:**\n${link}\n\n¿Cuál te gusta? Dime la marca y modelo (ej: "Toyota Corolla" o "Honda CR-V")`;
                    
                    sessionData.estado = 'seleccion_auto';
                } else {
                    respuesta += `😅 No encontré coincidencias exactas con tus preferencias.\n\n🔗 Te muestro opciones similares en nuestro catálogo:\n${link}\n\n¿Ves alguna que te interese? Dime el modelo.`;
                    sessionData.estado = 'seleccion_auto';
                }
                
                return res.json({ fulfillmentText: respuesta });
            } else {
                return res.json({ fulfillmentText: `¿Ciudad, Carretera o Mixto?` });
            }
        }
        
        // SELECCIÓN DE AUTO
        if (sessionData.estado === 'seleccion_auto') {
            const autoEncontrado = buscarAutoPorNombre(texto, autos);
            
            if (autoEncontrado) {
                sessionData.autoSeleccionado = autoEncontrado;
                sessionData.esperandoConfirmacion = true;
                
                const resp = `🚗 **${autoEncontrado.vehiculo}**\n• Precio: $${autoEncontrado.precio}/día\n• Transmisión: ${autoEncontrado.transmision}\n• Puertas: ${autoEncontrado.puertas}\n• Pasajeros: ${autoEncontrado.pasajeros}\n• Año: ${autoEncontrado.año}\n\n¿Quieres rentar este vehículo? (Responde "Sí" o "No")`;
                
                return res.json({ fulfillmentText: resp });
            } else {
                const link = generarLink(sessionData.preferencias);
                const resp = `No encontré ese modelo específico. ¿Puedes revisar el catálogo y decirme el nombre exacto?\n\n🔗 ${link}`;
                return res.json({ fulfillmentText: resp });
            }
        }
        
        // FALLBACK
        const respuestasDefault = {
            'hola': '¡Hola! ¿En qué puedo ayudarte?\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva',
            'gracias': '¡De nada! ¿Necesitas algo más?',
            'adios': '¡Hasta luego! Cuando necesites rentar un auto, aquí estaré.'
        };
        
        for (const [clave, respuesta] of Object.entries(respuestasDefault)) {
            if (texto.includes(clave)) {
                return res.json({ fulfillmentText: respuesta });
            }
        }
        
        // Si nada funciona, volver al menú
        const respMenu = `¿En qué puedo ayudarte?\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva\n4️⃣ Requisitos\n5️⃣ Soporte`;
        sessionData.estado = 'menu_principal';
        return res.json({ fulfillmentText: respMenu });
        
    } catch (error) {
        console.error("❌ ERROR CRÍTICO:", error);
        res.json({ 
            fulfillmentText: "Lo siento, hubo un error. Por favor, intenta de nuevo:\n1️⃣ Rentar auto\n2️⃣ Ver catálogo" 
        });
    }
});

// ===============================
// 🔹 ENDPOINTS ADMIN
// ===============================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        sesiones: sesiones.size,
        cacheAutos: cacheAutos.data.length
    });
});

// ===============================
// 🚀 INICIAR SERVIDOR
// ===============================
app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🚗 AutoRent AI - v4.0 CORREGIDO     ║
╠════════════════════════════════════════╣
║ Puerto: ${port}
║ Catálogo: ${CATALOGO_URL}
║ ✅ Links funcionales
║ ✅ Flujo de reserva completo
║ ✅ Recomendaciones por preferencias
╚════════════════════════════════════════╝
    `);
});
