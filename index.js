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
// 🔥 CONFIGURACIÓN OPTIMIZADA
// ===============================
const CATALOGO_URL = process.env.CATALOGO_URL || "https://tu-app.onrender.com/catalogo.html";
const MAX_HISTORIAL = 6;
const TOKEN_LIMIT_WARNING = 5000;
const MAX_RESPONSE_TOKENS = 400;

// Cache de autos optimizada
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

// Limpieza de sesiones cada 30 minutos
setInterval(() => {
    const ahora = Date.now();
    let limpiadas = 0;
    
    for (const [sessionId, data] of sesiones.entries()) {
        if (data.lastActivity && (ahora - data.lastActivity) > 30 * 60 * 1000) {
            sesiones.delete(sessionId);
            limpiadas++;
        }
    }
    
    if (limpiadas > 0) {
        console.log(`🧹 ${limpiadas} sesiones limpiadas`);
    }
}, 30 * 60 * 1000);

// ===============================
// 🔹 CACHÉ OPTIMIZADA DE AUTOS
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
                transmision: a.Transmision || 'Auto',
                puertas: a.Puertas || '4',
                pasajeros: a.Asientos || a.Pasajeros || '5',
                año: a.Año || '2024'
            }));

        const resumen = crearResumenUltraComprimido(autosProcesados);
        
        cacheAutos = {
            data: autosProcesados,
            resumen: resumen,
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
// 🔹 RESUMEN ULTRA-COMPRIMIDO
// ===============================
function crearResumenUltraComprimido(autos) {
    const porTipo = {};
    autos.forEach(a => {
        if (!porTipo[a.tipo]) porTipo[a.tipo] = { autos: [], minPrecio: Infinity, maxPrecio: 0 };
        porTipo[a.tipo].autos.push(a);
        porTipo[a.tipo].minPrecio = Math.min(porTipo[a.tipo].minPrecio, a.precio);
        porTipo[a.tipo].maxPrecio = Math.max(porTipo[a.tipo].maxPrecio, a.precio);
    });
    
    const partes = [];
    for (const [tipo, data] of Object.entries(porTipo)) {
        const autosMuestra = data.autos.slice(0, 2).map(a => 
            `${a.marca[0]}${a.modelo[0]}`
        ).join('/');
        
        partes.push(`${tipo}:${data.autos.length}($${data.minPrecio}-${data.maxPrecio})[${autosMuestra}]`);
    }
    
    const marcas = {};
    autos.forEach(a => marcas[a.marca] = (marcas[a.marca] || 0) + 1);
    const topMarcas = Object.entries(marcas)
        .sort((a,b) => b[1]-a[1])
        .slice(0,3)
        .map(([m,c]) => m.substring(0,3))
        .join(',');
    
    return `TOTAL:${autos.length}|TIPOS:${partes.join(';')}|TOP:${topMarcas}`;
}

// ===============================
// 🔹 API OPTIMIZADA
// ===============================
app.get('/api/autos', async (req, res) => {
    try {
        const autos = await obtenerAutos();
        let resultados = [...autos];
        
        const { tipo, marca, precio_max, pasajeros, search } = req.query;
        if (tipo) resultados = resultados.filter(a => a.tipo.toLowerCase().includes(tipo.toLowerCase()));
        if (marca) resultados = resultados.filter(a => a.marca.toLowerCase().includes(marca.toLowerCase()));
        if (precio_max) resultados = resultados.filter(a => a.precio <= parseFloat(precio_max));
        if (pasajeros) resultados = resultados.filter(a => parseInt(a.pasajeros) >= parseInt(pasajeros));
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
// 🔹 PROMPT ULTRA-OPTIMIZADO
// ===============================
function generarPromptUltraOptimizado(autos, datosUsuario) {
    const resumenCache = cacheAutos.resumen || crearResumenUltraComprimido(autos);
    
    const userStr = datosUsuario?.nombre ? 
        `U:${datosUsuario.nombre.split(' ')[0]}|T:${datosUsuario.telefono?.slice(-4)||'?'}` : 
        'U:NUEVO';
    
    return `Eres AutoRent. Sé breve. NO envíes imágenes. Usa links.
    
📊${resumenCache}|${userStr}

🎯MENÚ INICIAL:
"Bienvenido a AutoRent. Proporciona: Nombre, Email, WhatsApp. Opciones:
1 Rentar 2 Catálogo 3 Cancelar 4 Requisitos 5 Soporte"

📋REGLAS:
-NO imágenes. Envía: ${CATALOGO_URL}?filtros
-Validar: Tel(10d), Email(@), Fechas(fin>inicio)
-Rentar: 1)Preguntar tipo 2)Enviar link 3)Fechas 4)Confirmar
-Cancelar: Pedir folio, simular
-Requisitos: INE, Lic, TC, +21a
-Soporte: "Agente contactará en 5-15min"

💰PRECIOS:${autos.slice(0,5).map(a=>`${a.vehiculo.substring(0,10)}:$${a.precio}`).join(';')}

📊JSON:{r:"texto",a:"hablar|catalogo|cancelar|guardar",p:{tipo,marca,precio_max},c:{nombre,tel,email},v:{vehiculo,inicio,fin,dias,total}}

Responde SOLO JSON. Máximo 400 tokens.`;
}

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
    if (txt.includes('pickup') || txt.includes('pick up')) return 'Pickup';
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
    if (datos.fecha_inicio && datos.fecha_fin) {
        const inicio = new Date(datos.fecha_inicio);
        const fin = new Date(datos.fecha_fin);
        if (isNaN(inicio) || isNaN(fin) || fin <= inicio) {
            errores.push('Fechas inválidas');
        }
    }
    return errores;
}

// ===============================
// 🔹 GENERADOR DE LINK
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    params.append('ref', 'chat');
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 ENVÍOS (WhatsApp y Email)
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
function gestionarSesion(sessionId, promptSistema) {
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
            }
        });
    }
    
    const sessionData = sesiones.get(sessionId);
    sessionData.lastActivity = Date.now();
    
    if (sessionData.historial.length > MAX_HISTORIAL) {
        sessionData.historial = sessionData.historial.slice(-MAX_HISTORIAL);
    }
    
    return sessionData;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
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

        const sessionData = gestionarSesion(sessionId, '');
        
        // PRIMERA INTERACCIÓN
        if (sessionData.historial.length === 0) {
            const bienvenida = `¡Bienvenido a AutoRent! 🚗\n\nProporcióname:\n• Nombre completo\n• Email\n• WhatsApp (10 dígitos)\n\nOpciones:\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva\n4️⃣ Requisitos\n5️⃣ Soporte`;
            
            sessionData.historial.push({ 
                role: "assistant", 
                content: JSON.stringify({ r: bienvenida, a: "bienvenida" }) 
            });
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
        
        const texto = queryText.toLowerCase().trim();
        
        // MANEJO DE MENÚ PRINCIPAL
        if (texto.match(/^[1-5]$/)) {
            const opcion = parseInt(texto);
            
            switch(opcion) {
                case 1: // Rentar
                    sessionData.estado = 'preguntando_tipo';
                    const resp1 = `¡Excelente! ¿Qué tipo de vehículo buscas?\n• Económico\n• Sedan\n• SUV\n• Lujo\n• Camioneta\n• Deportivo`;
                    sessionData.historial.push({ role: "assistant", content: JSON.stringify({ r: resp1, a: "rentar" }) });
                    return res.json({ fulfillmentText: resp1 });
                    
                case 2: // Catálogo
                    sessionData.estado = 'menu_principal';
                    const link = generarLink({});
                    const resp2 = `🔗 Catálogo completo:\n${link}\n\nCuando encuentres un auto, dime el modelo para continuar.`;
                    sessionData.historial.push({ role: "assistant", content: JSON.stringify({ r: resp2, a: "catalogo" }) });
                    return res.json({ fulfillmentText: resp2 });
                    
                case 3: // Cancelar
                    sessionData.estado = 'esperando_folio';
                    const resp3 = `Para cancelar una reserva, necesito el folio de confirmación (ej: AR123ABC). ¿Podrías proporcionármelo?`;
                    sessionData.historial.push({ role: "assistant", content: JSON.stringify({ r: resp3, a: "cancelar" }) });
                    return res.json({ fulfillmentText: resp3 });
                    
                case 4: // Requisitos
                    sessionData.estado = 'menu_principal';
                    const resp4 = `📋 Requisitos para rentar:\n• INE/Pasaporte vigente\n• Licencia de conducir vigente\n• Tarjeta de crédito (garantía)\n• Mayor de 21 años\n\n¿Te gustaría ver autos? Responde 1 para rentar o 2 para catálogo.`;
                    sessionData.historial.push({ role: "assistant", content: JSON.stringify({ r: resp4, a: "requisitos" }) });
                    return res.json({ fulfillmentText: resp4 });
                    
                case 5: // Soporte
                    sessionData.estado = 'menu_principal';
                    const nombre = sessionData.datosUsuario?.nombre?.split(' ')[0] || '';
                    const resp5 = `${nombre ? '¡Gracias ' + nombre + '! ' : ''}Un agente te contactará en 5-15 minutos al WhatsApp proporcionado. ¿Puedo ayudarte con algo más?`;
                    sessionData.historial.push({ role: "assistant", content: JSON.stringify({ r: resp5, a: "soporte" }) });
                    return res.json({ fulfillmentText: resp5 });
            }
        }
        
        // PALABRAS CLAVE DEL MENÚ
        if (texto.includes('catálogo') || texto.includes('catalogo') || texto.includes('ver autos')) {
            sessionData.estado = 'menu_principal';
            const link = generarLink(sessionData.preferencias || {});
            const resp = `🔗 Catálogo:\n${link}\n\nDime el modelo que te interese.`;
            return res.json({ fulfillmentText: resp });
        }
        
        if (texto.includes('rentar') || texto.includes('alquilar')) {
            sessionData.estado = 'preguntando_tipo';
            const resp = `¡Claro! ¿Qué tipo de vehículo buscas?\n• Económico\n• Sedan\n• SUV\n• Lujo\n• Camioneta`;
            return res.json({ fulfillmentText: resp });
        }
        
        // CANCELACIÓN DE RESERVA
        if (sessionData.estado === 'esperando_folio') {
            const folio = queryText.trim().toUpperCase();
            
            if (folio.match(/^AR[A-Z0-9]+$/)) {
                const resultado = await cancelarReserva(folio);
                
                if (resultado.success) {
                    const respCancel = `✅ Reserva ${folio} cancelada exitosamente.\n\n¿Necesitas algo más?\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n4️⃣ Soporte`;
                    sessionData.estado = 'menu_principal';
                    return res.json({ fulfillmentText: respCancel });
                } else {
                    return res.json({ fulfillmentText: `❌ ${resultado.message}. Intenta de nuevo o responde "menú".` });
                }
            } else {
                return res.json({ fulfillmentText: `❌ Folio inválido. Debe ser como AR123ABC. Intenta de nuevo.` });
            }
        }
        
        // PREGUNTAS SECUENCIALES PARA RENTA
        if (sessionData.estado === 'preguntando_tipo') {
            const tipoDetectado = detectarTipoVehiculo(texto);
            
            if (tipoDetectado) {
                sessionData.preferencias.tipo = tipoDetectado;
                sessionData.estado = 'preguntando_transmision';
                
                const resp = `✅ ${tipoDetectado}\n\n¿Prefieres transmisión automática o estándar?`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `Por favor, selecciona: Económico, Sedan, SUV, Lujo o Camioneta` });
            }
        }
        
        if (sessionData.estado === 'preguntando_transmision') {
            const transmisionDetectada = detectarTransmision(texto);
            
            if (transmisionDetectada) {
                sessionData.preferencias.transmision = transmisionDetectada;
                sessionData.estado = 'preguntando_puertas';
                
                const resp = `✅ ${transmisionDetectada}\n\n¿Cuántas puertas necesitas? (2, 4, 5)`;
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
                
                const resp = `✅ ${puertasDetectadas} puertas\n\n¿Para cuántos pasajeros? (2, 4, 5, 7)`;
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
                
                const resp = `✅ ${pasajerosDetectados} pasajeros\n\n¿Cuál es tu presupuesto máximo por día? (en pesos)`;
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
                
                const resp = `✅ $${presupuesto} por día\n\n¿Qué uso le darás?\n• Ciudad\n• Carretera/Viaje\n• Mixto`;
                return res.json({ fulfillmentText: resp });
            } else {
                return res.json({ fulfillmentText: `¿Cuánto quieres gastar por día? (ej: 500)` });
            }
        }
        
        if (sessionData.estado === 'preguntando_uso') {
            const usoDetectado = detectarUso(texto);
            
            if (usoDetectado) {
                sessionData.preferencias.uso = usoDetectado;
                
                const autosFiltrados = filtrarAutosCompleto(autos, sessionData.preferencias);
                const link = generarLink(sessionData.preferencias);
                
                let respuesta = `🎯 ¡Perfecto! Con tus preferencias:\n`;
                respuesta += `• Tipo: ${sessionData.preferencias.tipo}\n`;
                respuesta += `• Transmisión: ${sessionData.preferencias.transmision}\n`;
                respuesta += `• Puertas: ${sessionData.preferencias.puertas}\n`;
                respuesta += `• Pasajeros: ${sessionData.preferencias.pasajeros}\n`;
                respuesta += `• Presupuesto: $${sessionData.preferencias.precio_max}/día\n`;
                respuesta += `• Uso: ${sessionData.preferencias.uso}\n\n`;
                
                if (autosFiltrados.length > 0) {
                    respuesta += `✅ ${autosFiltrados.length} opciones:\n\n`;
                    
                    autosFiltrados.slice(0, 3).forEach(auto => {
                        respuesta += `🚗 ${auto.vehiculo}\n   $${auto.precio}/día | ${auto.transmision} | ${auto.puertas}p | ${auto.pasajeros} pas\n\n`;
                    });
                    
                    if (autosFiltrados.length > 3) {
                        respuesta += `Y ${autosFiltrados.length - 3} más...\n`;
                    }
                    
                    respuesta += `\n🔗 Ver catálogo: ${link}\n\n¿Cuál te gusta? Dime el modelo.`;
                } else {
                    respuesta += `😅 No hay coincidencias exactas. Mira opciones similares:\n${link}`;
                }
                
                sessionData.estado = 'seleccion_auto';
                return res.json({ fulfillmentText: respuesta });
            } else {
                return res.json({ fulfillmentText: `¿Ciudad, Carretera o Mixto?` });
            }
        }
        
        // FALLBACK A IA
        console.log('🤖 Usando IA como fallback...');
        
        sessionData.historial.push({ role: "user", content: queryText });
        
        const promptSistema = generarPromptUltraOptimizado(autos, sessionData.datosUsuario);
        sessionData.historial[0] = { role: "system", content: promptSistema };
        
        let respuestaIA;
        try {
            const completion = await groq.chat.completions.create({
                messages: sessionData.historial,
                model: "llama-3.1-8b-instant",
                response_format: { type: "json_object" },
                temperature: 0.3,
                max_tokens: MAX_RESPONSE_TOKENS
            });
            
            const content = completion.choices[0].message.content.trim();
            respuestaIA = JSON.parse(content);
            
            if (!respuestaIA.respuesta_usuario && respuestaIA.r) {
                respuestaIA.respuesta_usuario = respuestaIA.r;
                respuestaIA.accion = respuestaIA.a || 'hablar';
            }
            
        } catch (error) {
            console.error("❌ Error Groq:", error.message);
            
            return res.json({ 
                fulfillmentText: `Lo siento, tuve un error. ¿Podrías intentar de nuevo?\n\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva\n4️⃣ Requisitos\n5️⃣ Soporte` 
            });
        }
        
        let respuestaFinal = respuestaIA.respuesta_usuario;
        
        if (respuestaIA.accion === "catalogo" || respuestaIA.accion === "recomendar") {
            const link = generarLink(respuestaIA.preferencias || {});
            if (!respuestaFinal.includes(link)) {
                respuestaFinal += `\n\n🔗 ${link}`;
            }
        }
        
        if (respuestaIA.accion === "guardar_reserva") {
            const datos_cliente = respuestaIA.c || respuestaIA.datos_cliente || sessionData.datosUsuario || {};
            const datos_reserva = respuestaIA.v || respuestaIA.datos_reserva || {};
            
            const errores = validarDatosRapido({
                ...datos_cliente,
                ...datos_reserva
            });
            
            if (errores.length > 0) {
                respuestaFinal = `❌ ${errores.join('. ')}`;
            } else {
                const folio = await guardarReserva(datos_cliente, datos_reserva);
                
                if (folio) {
                    enviarWhatsApp(datos_cliente.telefono, 
                        `✅ Reserva #${folio}\n${datos_reserva.vehiculo}\n${datos_reserva.fecha_inicio}-${datos_reserva.fecha_fin}\nTotal: $${datos_reserva.precio_total}`
                    ).catch(console.error);
                    
                    enviarCorreo(datos_cliente.correo, datos_reserva, datos_cliente, folio)
                        .catch(console.error);
                    
                    respuestaFinal = `✅ ¡Reserva confirmada!\nFolio: ${folio}\n${datos_reserva.vehiculo}\n${datos_reserva.fecha_inicio} al ${datos_reserva.fecha_fin}\nTotal: $${datos_reserva.precio_total}\n\nTe enviamos los detalles.`;
                    sessionData.estado = 'menu_principal';
                } else {
                    respuestaFinal = "❌ Error al guardar reserva. Intenta de nuevo.";
                }
            }
        }
        
        sessionData.historial.push({ 
            role: "assistant", 
            content: JSON.stringify({ r: respuestaFinal.substring(0, 200), a: respuestaIA.accion }) 
        });
        
        res.json({ fulfillmentText: respuestaFinal });
        
    } catch (error) {
        console.error("❌ ERROR CRÍTICO:", error);
        res.json({ 
            fulfillmentText: "Error interno. Intenta de nuevo:\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva\n4️⃣ Requisitos\n5️⃣ Soporte" 
        });
    }
});

// ===============================
// 🔹 ENDPOINTS ADMIN
// ===============================
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        sesiones: sesiones.size,
        cacheAutos: cacheAutos.data.length,
        memoria: {
            usada: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
        }
    });
});

app.post('/admin/clear-cache', (req, res) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${process.env.ADMIN_TOKEN}`) {
        cacheAutos.data = [];
        cacheAutos.resumen = "";
        cacheAutos.lastUpdate = null;
        sesiones.clear();
        res.json({ success: true, message: 'Caché limpiada' });
    } else {
        res.status(401).json({ error: 'No autorizado' });
    }
});

// ===============================
// 🚀 INICIAR SERVIDOR
// ===============================
app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════╗
║   🚗 AutoRent AI - Optimizado 6000tk  ║
╠════════════════════════════════════════╣
║ Puerto: ${port}
║ Catálogo: ${CATALOGO_URL}
║ Max Historial: ${MAX_HISTORIAL} mensajes
╚════════════════════════════════════════╝
    `);
});
