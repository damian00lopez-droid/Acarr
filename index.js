require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sesiones = new Map();

// 🟢 TU NÚMERO DE WHATSAPP PARA RECIBIR MENSAJES (Cambia esto)
// Escríbelo con el código de país, sin el signo de + y sin espacios. Ej: 521234567890
const NUMERO_EMPRESA = "525555555555"; 

// ===============================
// 🔹 FUNCTION PARA AUTOMATIKO A WHATSAPP
// ===============================
async function agpatulodWhatsApp(numero, mensahe) {
    // I-format ti numero (ikkatem ti + ken pasig a numero laeng)
    const numeroPormal = numero.replace(/\D/g, '');
    console.log(`[WhatsApp API] Mangipatulod iti mensahe iti ${numeroPormal}: ${mensahe}`);
    
    // PAALALA: Tapno pudno nga ag-send ti mensahe nga automatiko, kasapulam ti Meta Cloud API.
    /*
    const META_TOKEN = process.env.WHATSAPP_TOKEN;
    const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
    
    try {
        await fetch(`https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST
