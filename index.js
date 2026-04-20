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
const MAX_HISTORIAL = 6; // REDUCIDO para ahorrar tokens
const TOKEN_LIMIT_WARNING = 5000; // Advertencia a 5000 tokens
const MAX_RESPONSE_TOKENS = 400; // Máximo tokens en respuesta

// Cache de autos optimizada
let cacheAutos = {
    data: [],
    resumen: "", // Versión comprimida para prompts
    lastUpdate: null,
    ttl: 10 * 60 * 1000 // 10 minutos (antes 5)
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

// Limpieza agresiva de sesiones (cada 30 minutos)
setInterval(() => {
    const ahora = Date.now();
    let limpiadas = 0;
    
    for (const [sessionId, data] of sesiones.entries()) {
        // Sesiones inactivas por más de 30 minutos
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
                pasajeros: a.Asientos || a.Pasajeros || '5',
                año: a.Año || '2024'
            }));

        // Crear resumen ultra-comprimido para prompts
        const resumen = crearResumenUltraComprimido(autosProcesados);
        
        cacheAutos = {
            data: autosProcesados,
            resumen: resumen,
            lastUpdate: Date.now(),
            ttl: cacheAutos.ttl
        };

        console.log(`✅ ${autosProcesados.length} autos en caché (${resumen.length} chars resumen)`);
        return autosProcesados;
        
    } catch (error) {
        console.error("❌ Error catálogo:", error.message);
        return cacheAutos.data.length ? cacheAutos.data : [];
    }
}

// ===============================
// 🔹 RESUMEN ULTRA-COMPRIMIDO (Ahorra ~70% tokens)
// ===============================
function crearResumenUltraComprimido(autos) {
    // Agrupar por tipo y calcular stats
    const porTipo = {};
    autos.forEach(a => {
        if (!porTipo[a.tipo]) porTipo[a.tipo] = { autos: [], minPrecio: Infinity, maxPrecio: 0 };
        porTipo[a.tipo].autos.push(a);
        porTipo[a.tipo].minPrecio = Math.min(porTipo[a.tipo].minPrecio, a.precio);
        porTipo[a.tipo].maxPrecio = Math.max(porTipo[a.tipo].maxPrecio, a.precio);
    });
    
    // Crear resumen minimalista
    const partes = [];
    for (const [tipo, data] of Object.entries(porTipo)) {
        const autosMuestra = data.autos.slice(0, 2).map(a => 
            `${a.marca[0]}${a.modelo[0]}` // Solo iniciales para ahorrar
        ).join('/');
        
        partes.push(`${tipo}:${data.autos.length}($${data.minPrecio}-${data.maxPrecio})[${autosMuestra}]`);
    }
    
    // Añadir top 3 marcas
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
        
        // Filtros rápidos
        const { tipo, marca, precio_max, pasajeros } = req.query;
        if (tipo) resultados = resultados.filter(a => a.tipo.toLowerCase().includes(tipo.toLowerCase()));
        if (marca) resultados = resultados.filter(a => a.marca.toLowerCase().includes(marca.toLowerCase()));
        if (precio_max) resultados = resultados.filter(a => a.precio <= parseFloat(precio_max));
        if (pasajeros) resultados = resultados.filter(a => parseInt(a.pasajeros) >= parseInt(pasajeros));
        
        // Paginación
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 50); // Máximo 50
        const start = (page - 1) * limit;
        
        res.json({
            success: true,
            total: resultados.length,
            data: resultados.slice(start, start + limit),
            cache: {
                age: cacheAutos.lastUpdate ? Math.floor((Date.now() - cacheAutos.lastUpdate) / 1000) : null
            }
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: "Error interno" });
    }
});

// ===============================
// 🔹 PROMPT ULTRA-OPTIMIZADO (Versión 6000 tokens)
// ===============================
function generarPromptUltraOptimizado(autos, datosUsuario) {
    const resumenCache = cacheAutos.resumen || crearResumenUltraComprimido(autos);
    
    // Datos de usuario ultra-comprimidos
    const userStr = datosUsuario?.nombre ? 
        `U:${datosUsuario.nombre.split(' ')[0]}|T:${datosUsuario.telefono?.slice(-4)||'?'}` : 
        'U:NUEVO';
    
    return `Eres AutoRent. Sé breve. NO envíes imágenes. Usa links.
    
📊${resumenCache}|${userStr}

🎯MENÚ INICIAL(si es nuevo):
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
// 🔹 DETECCIÓN DE INTENCIONES SIN IA (Ahorra tokens)
// ===============================
function detectarIntencionSinIA(texto) {
    const txt = texto.toLowerCase();
    
    // Patrones predefinidos
    if (txt.match(/^[12345]$/)) {
        return { tipo: 'menu', valor: parseInt(txt) };
    }
    
    if (txt.includes('catalogo') || txt.includes('ver autos') || txt.includes('2')) {
        return { tipo: 'catalogo' };
    }
    
    if (txt.includes('cancelar') || txt.includes('3')) {
        return { tipo: 'cancelar' };
    }
    
    if (txt.includes('requisito') || txt.includes('4')) {
        return { tipo: 'requisitos' };
    }
    
    if (txt.includes('soporte') || txt.includes('ayuda') || txt.includes('5')) {
        return { tipo: 'soporte' };
    }
    
    if (txt.includes('rentar') || txt.includes('alquilar') || txt.includes('1')) {
        return { tipo: 'rentar' };
    }
    
    // Extraer datos de contacto
    const email = texto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const telefono = texto.match(/\b\d{10,15}\b/);
    const nombre = texto.match(/[A-Z][a-záéíóúñ]+ [A-Z][a-záéíóúñ]+/);
    
    if (email || telefono || nombre) {
        return { 
            tipo: 'datos_contacto', 
            datos: {
                email: email?.[0],
                telefono: telefono?.[0],
                nombre: nombre?.[0]
            }
        };
    }
    
    return null;
}

// ===============================
// 🔹 RESPUESTAS PREDEFINIDAS (Sin usar IA)
// ===============================
function obtenerRespuestaPredefinida(intencion, datosUsuario = null) {
    const nombre = datosUsuario?.nombre?.split(' ')[0] || '';
    const saludo = nombre ? `¡Hola ${nombre}! ` : '';
    
    const respuestas = {
        'catalogo': {
            texto: `${saludo}Aquí está nuestro catálogo completo: ${CATALOGO_URL}?ref=chatbot&view=all\n\nCuando encuentres un auto que te guste, regresa y dime el modelo para continuar con tu renta.`,
            accion: 'catalogo'
        },
        'cancelar': {
            texto: `${saludo}Para cancelar una reserva, necesito el folio de confirmación (ej: AR123ABC). ¿Podrías proporcionármelo?`,
            accion: 'cancelar'
        },
        'requisitos': {
            texto: `📋 Requisitos para rentar:\n• INE/Pasaporte vigente\n• Licencia de conducir vigente\n• Tarjeta de crédito (garantía)\n• Mayor de 21 años\n\n¿Te gustaría ver autos disponibles? Responde 1 para rentar o 2 para ver catálogo.`,
            accion: 'requisitos'
        },
        'soporte': {
            texto: `${saludo}Un agente de soporte se comunicará contigo en los próximos 5-15 minutos al WhatsApp proporcionado. Mientras tanto, ¿puedo ayudarte con algo más?`,
            accion: 'soporte'
        },
        'rentar': {
            texto: `${saludo}¡Excelente! ¿Qué tipo de vehículo buscas?\n• Económico ($)\n• Sedan ($$)\n• SUV ($$$)\n• Lujo ($$$$)\n• Camioneta\n\nTambién dime tu presupuesto aproximado por día.`,
            accion: 'rentar'
        }
    };
    
    return respuestas[intencion] || null;
}

// ===============================
// 🔹 VALIDACIONES RÁPIDAS
// ===============================
function validarDatosRapido(datos) {
    const errores = [];
    if (datos.telefono && !/^\d{10,15}$/.test(datos.telefono.replace(/\D/g, ''))) {
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
// 🔹 GENERADOR DE LINK OPTIMIZADO
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
// 🔹 ENVÍOS (WhatsApp y Email optimizados)
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
            Estado: 'Confirmada'
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

// ===============================
// 🔹 GESTIÓN DE SESIONES OPTIMIZADA
// ===============================
function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, {
            historial: [],
            datosUsuario: null,
            lastActivity: Date.now(),
            intentosIA: 0 // Contador para decidir cuándo usar IA
        });
    }
    
    const sessionData = sesiones.get(sessionId);
    sessionData.lastActivity = Date.now();
    
    // Mantener solo los últimos 6 mensajes (ahorra tokens)
    if (sessionData.historial.length > MAX_HISTORIAL) {
        sessionData.historial = sessionData.historial.slice(-MAX_HISTORIAL);
    }
    
    // Actualizar prompt del sistema
    if (sessionData.historial.length === 0 || sessionData.historial[0].role !== "system") {
        sessionData.historial.unshift({ role: "system", content: promptSistema });
    } else {
        sessionData.historial[0].content = promptSistema;
    }
    
    return sessionData;
}

// ===============================
// 🔹 ESTIMADOR DE TOKENS (Simple)
// ===============================
function estimarTokens(texto) {
    // Estimación: ~4 caracteres por token en español
    return Math.ceil(texto.length / 4);
}

// ===============================
// 🚀 WEBHOOK ULTRA-OPTIMIZADO
// ===============================
app.post('/webhook', async (req, res) => {
    console.log(`📨 Webhook recibido - ${new Date().toISOString()}`);
    
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        // Obtener autos (con caché)
        const autos = await obtenerAutos();
        
        if (autos.length === 0) {
            return res.json({ 
                fulfillmentText: "Catálogo no disponible. Intenta más tarde." 
            });
        }

        // Gestionar sesión
        const sessionData = gestionarSesion(sessionId, '');
        
        // PRIMERA INTERACCIÓN: Menú inicial
        if (sessionData.historial.length <= 1) {
            const bienvenida = `¡Bienvenido a AutoRent! 🚗\n\nProporcióname:\n• Nombre completo\n• Email\n• WhatsApp (10 dígitos)\n\nOpciones:\n1️⃣ Rentar auto\n2️⃣ Ver catálogo\n3️⃣ Cancelar reserva\n4️⃣ Requisitos\n5️⃣ Soporte`;
            
            sessionData.historial.push({ 
                role: "assistant", 
                content: JSON.stringify({ r: bienvenida, a: "bienvenida" }) 
            });
            
            return res.json({ fulfillmentText: bienvenida });
        }
        
        // INTENTAR DETECCIÓN SIN IA PRIMERO (Ahorra tokens)
        const intencionSimple = detectarIntencionSinIA(queryText);
        
        if (intencionSimple) {
            console.log(`✅ Intención detectada sin IA: ${intencionSimple.tipo}`);
            
            // Procesar datos de contacto
            if (intencionSimple.tipo === 'datos_contacto') {
                sessionData.datosUsuario = {
                    ...sessionData.datosUsuario,
                    ...intencionSimple.datos
                };
                
                const respuesta = `¡Gracias ${intencionSimple.datos.nombre?.split(' ')[0] || ''}! ¿En qué puedo ayudarte?\n1 Rentar 2 Catálogo 3 Cancelar 4 Requisitos 5 Soporte`;
                sessionData.historial.push({ role: "assistant", content: JSON.stringify({ r: respuesta, a: "datos" }) });
                return res.json({ fulfillmentText: respuesta });
            }
            
            // Respuestas predefinidas para opciones del menú
            const respuestaPredef = obtenerRespuestaPredefinida(intencionSimple.tipo, sessionData.datosUsuario);
            if (respuestaPredef) {
                sessionData.historial.push({ 
                    role: "assistant", 
                    content: JSON.stringify(respuestaPredef) 
                });
                return res.json({ fulfillmentText: respuestaPredef.texto });
            }
        }
        
        // SI NO SE DETECTA, USAR IA (pero con prompt ultra-comprimido)
        sessionData.intentosIA++;
        
        // Agregar mensaje del usuario
        sessionData.historial.push({ role: "user", content: queryText });
        
        // Generar prompt ultra-optimizado
        const promptSistema = generarPromptUltraOptimizado(autos, sessionData.datosUsuario);
        sessionData.historial[0].content = promptSistema;
        
        // Estimar tokens antes de enviar
        const historialStr = JSON.stringify(sessionData.historial);
        const tokensEstimados = estimarTokens(historialStr);
        
        console.log(`📊 Tokens estimados: ${tokensEstimados}/6000`);
        
        if (tokensEstimados > TOKEN_LIMIT_WARNING) {
            console.warn(`⚠️ ¡ALERTA! Tokens altos: ${tokensEstimados}`);
            // Limpiar historial agresivamente
            sessionData.historial = [
                sessionData.historial[0], // System prompt
                sessionData.historial[sessionData.historial.length - 1] // Último mensaje
            ];
        }
        
        // Llamar a Groq
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
            
            // Compatibilidad con formato comprimido
            if (!respuestaIA.respuesta_usuario && respuestaIA.r) {
                respuestaIA.respuesta_usuario = respuestaIA.r;
                respuestaIA.accion = respuestaIA.a || 'hablar';
            }
            
        } catch (error) {
            console.error("❌ Error Groq:", error.message);
            respuestaIA = {
                respuesta_usuario: "Lo siento, tuve un error. ¿Podrías intentar de nuevo?",
                accion: "error"
            };
        }
        
        let respuestaFinal = respuestaIA.respuesta_usuario;
        
        // PROCESAR ACCIONES
        if (respuestaIA.accion === "catalogo" || respuestaIA.accion === "recomendar") {
            const link = generarLink(respuestaIA.preferencias || {});
            if (!respuestaFinal.includes(link)) {
                respuestaFinal += `\n\n🔗 ${link}`;
            }
        }
        
        if (respuestaIA.accion === "guardar_reserva") {
            const datos_cliente = respuestaIA.c || respuestaIA.datos_cliente || {};
            const datos_reserva = respuestaIA.v || respuestaIA.datos_reserva || {};
            
            // Validaciones
            const errores = validarDatosRapido({
                ...datos_cliente,
                ...datos_reserva
            });
            
            if (errores.length > 0) {
                respuestaFinal = `❌ ${errores.join('. ')}`;
            } else {
                const folio = await guardarReserva(datos_cliente, datos_reserva);
                
                if (folio) {
                    // Notificaciones asíncronas (no esperamos)
                    enviarWhatsApp(datos_cliente.telefono, 
                        `✅ Reserva #${folio}\n${datos_reserva.vehiculo}\n${datos_reserva.fecha_inicio}-${datos_reserva.fecha_fin}\nTotal: $${datos_reserva.precio_total}`
                    ).catch(console.error);
                    
                    enviarCorreo(datos_cliente.correo, datos_reserva, datos_cliente, folio)
                        .catch(console.error);
                    
                    respuestaFinal = `✅ ¡Reserva confirmada!\nFolio: ${folio}\n${datos_reserva.vehiculo}\n${datos_reserva.fecha_inicio} al ${datos_reserva.fecha_fin}\nTotal: $${datos_reserva.precio_total}\n\nTe enviamos los detalles por WhatsApp y email.`;
                } else {
                    respuestaFinal = "❌ Error al guardar reserva. Intenta de nuevo.";
                }
            }
        }
        
        // Guardar respuesta en historial (comprimida)
        sessionData.historial.push({ 
            role: "assistant", 
            content: JSON.stringify({
                r: respuestaFinal.substring(0, 200), // Solo guardamos primeras 200 chars
                a: respuestaIA.accion
            }) 
        });
        
        res.json({ fulfillmentText: respuestaFinal });
        
    } catch (error) {
        console.error("❌ ERROR CRÍTICO:", error);
        res.json({ 
            fulfillmentText: "Error interno. Por favor, intenta de nuevo." 
        });
    }
});

// ===============================
// 🔹 ENDPOINTS ADMINISTRATIVOS
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
║ Token Warning: ${TOKEN_LIMIT_WARNING}
╚════════════════════════════════════════╝
    `);
});
