import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import fetch from 'node-fetch';
import { PythonShell } from 'python-shell';
import { v4 as uuidv4 } from 'uuid';

import { decrypt } from '../auth-service/src/utils/crypto_importVersion.js';

import pool from './db.js';
import getMessagesBySA from '../../chatbot_functions/getMessagesBySA.js';
import getMessagesBySurvey from '../../chatbot_functions/getMessagesBySurvey.js';
import getConversationsByBizz from '../../chatbot_functions/getConversationsByBizz.js';
import getRealTimeConversations from '../../chatbot_functions/getRealTimeConversations.js';
import getConversationMessagesByConversationId from '../../chatbot_functions/getConversationMessagesByConversationId.js';
import getLatestValidConversation from '../../chatbot_functions/getLatestValidConversation.js';
import getLatestValidConversationForUserAndChannel from '../../chatbot_functions/getLatestValidConversationForUserAndChannel.js';
import getLatestValidConversationForDelete from '../../chatbot_functions/getLatestValidConversationForDelete.js';
import getValidAssistantConfig from '../../chatbot_functions/getValidAssistantConfig.js'
import getConversationsAdmin from '../../chatbot_functions/getConversationsAdmin.js';
import getUniqueUsersWithConversationCount from '../../chatbot_functions/getUniqueUsersWithConversationCount.js';
import getAllUserConfigs from '../../chatbot_functions/getAllUserConfigs.js';
import getAllBizzConfigs from '../../chatbot_functions/getAllBizzConfigs.js';
import getValidConversationForRecovery from '../../chatbot_functions/getValidConversationForRecovery.js';

import insertMessageRecoveryToConversation from '.././chatbot_functions/insertMessageRecoveryToConversation.js'

const app = express();
const ROOT = process.env.ROOT || '';
const PORT = process.env.PORT || 3002;

// ConfiguraciÃ³n de CORS: permitir solo cloud.bizzfront.com y localhost
const allowedOrigins = new Set([
  'https://cloud.bizzfront.com',
  'http://localhost'
]);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin) || origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    callback(new Error(`CORS no permitido por origen: ${origin}`));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// Middleware para parsear JSON
app.use(express.json());

// Middleware de autenticaciÃ³n JWT
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Malformed Authorization header' });
  }
  
  	console.log('>>> API-service JWT_SECRET:', process.env.JWT_SECRET);
    console.log('>>> Incoming token:', token);
    console.log('>>> Decoded (sin verificar):', jwt.decode(token));
	
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;  // { sub, bizz_id, scope, iat, exp }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Rutas protegidas
app.get(`${ROOT}/`, async (req, res) => {
  res.status(200).json({ Hello: 'report' });
});

app.get(`${ROOT}/report/leads/sa/:sa_id/get-messages`, async (req, res) => {
  const { sa_id } = req.params;
  if (!sa_id) {
    return res.status(400).json({ error: 'El Parametro sa_id es requerido' });
  }
  try {
    const messages = await getMessagesBySA(pool, sa_id);
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(`${ROOT}/report/leads/surveys/:survey_id/get-messages`, async (req, res) => {
  const { survey_id } = req.params;
  if (!survey_id) {
    return res.status(400).json({ error: 'El Parametro survey_id es requerido' });
  }
  try {
    const messages = await getMessagesBySurvey(pool, survey_id);
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/*app.get(`${ROOT}/report/bizz/conversations`, async (req, res) => {
  const { bizz_id } = req.user.bizz;
  if (!bizz_id) {
    return res.status(400).json({ error: 'El Parametro bizz_id es requerido' });
  }
  try {
    const conversations = await getConversationsAdmin(pool, bizz_id);
    res.status(200).json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
*/

app.get(`${ROOT}/report/bizz/conversations`, async (req, res) => {
  
  try {
	const {sub, bizz, scope} = req.user || null; //Parametro nuevo que debe ser agregado a la busqueda

	//const { id: bizz_id } = req.user.bizz || {};
	if (!bizz) {
		return res
		.status(400)
		.json({ error: 'Parametro bizz_id es obligatorio.' });
	}
    const { limit, page, init, end, assistant_assistant_id } = req.query;
    const options = {};
	
	options.bizzId = bizz;
	
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (limit !== undefined) {
      const lim = parseInt(limit, 10);
      if (isNaN(lim) || lim <= 0) {
        return res.status(400).json({ error: 'Parametro `limit` debe ser un entero positivo.' });
      }
      options.limit = lim;
    }
    if (page !== undefined) {
      const pg = parseInt(page, 10);
      if (isNaN(pg) || pg <= 0) {
        return res.status(400).json({ error: 'Parametro `page` debe ser un entero positivo.' });
      }
      options.page = pg;
    }
    if (init !== undefined) {
      if (!dateRegex.test(init)) {
        return res.status(400).json({ error: '`init` debe usar el formato YYYY-MM-DD.' });
      }
      options.init = init;
    }
    if (end !== undefined) {
      if (!dateRegex.test(end)) {
        return res.status(400).json({ error: '`end` debe usar el formato YYYY-MM-DD.' });
      }
      options.end = end;
    }
    if (options.init && options.end && new Date(options.init) > new Date(options.end)) {
      return res.status(400).json({ error: '`init` no puede ser posterior a `end`.' });
    }
    if (assistant_assistant_id) {
      options.assistantId = assistant_assistant_id;
    }
    const result = await getConversationsByBizz(pool, options);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(`${ROOT}/report/bizz/realtime/conversation`, async (req, res) => {
  
  try {
	const {sub, bizz, scope} = req.user || null; //Parametro nuevo que debe ser agregado a la busqueda

	//const { id: bizz_id } = req.user.bizz || {};
	if (!bizz) {
		return res
		.status(400)
		.json({ error: 'Parametro bizz_id es obligatorio.' });
	}
    const { limit, page, init, end, assistant_assistant_id } = req.query;
    const options = {};
	
	options.bizzId = bizz;
	
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (limit !== undefined) {
      const lim = parseInt(limit, 10);
      if (isNaN(lim) || lim <= 0) {
        return res.status(400).json({ error: 'Parametro `limit` debe ser un entero positivo.' });
      }
      options.limit = lim;
    }
    if (page !== undefined) {
      const pg = parseInt(page, 10);
      if (isNaN(pg) || pg <= 0) {
        return res.status(400).json({ error: 'Parametro `page` debe ser un entero positivo.' });
      }
      options.page = pg;
    }
    if (init !== undefined) {
      if (!dateRegex.test(init)) {
        return res.status(400).json({ error: '`init` debe usar el formato YYYY-MM-DD.' });
      }
      options.init = init;
    }
    if (end !== undefined) {
      if (!dateRegex.test(end)) {
        return res.status(400).json({ error: '`end` debe usar el formato YYYY-MM-DD.' });
      }
      options.end = end;
    }
    if (options.init && options.end && new Date(options.init) > new Date(options.end)) {
      return res.status(400).json({ error: '`init` no puede ser posterior a `end`.' });
    }
    if (assistant_assistant_id) {
      options.assistantId = assistant_assistant_id;
    }
    const result = await getRealTimeConversations(pool, options);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(`${ROOT}/report/bizz/:bizz_id/conversations`, async (req, res) => {
  const { bizz_id } = req.params;
  if (!bizz_id) {
    return res.status(400).json({ error: 'El Parametro bizz_id es requerido' });
  }
  try {
    const conversations = await getConversationsByBizz(pool, bizz_id);
    res.status(200).json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(`${ROOT}/report/detail/conversation/:conversation_id/messages`, async (req, res) => {
  const { conversation_id } = req.params;
  if (!conversation_id) {
    return res.status(400).json({ error: 'El Parametro conversation_id es requerido' });
  }
  try {
    const messages = await getConversationMessagesByConversationId(pool, conversation_id);
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(`${ROOT}/report/bizz/conversations/admin`, async (req, res) => {
	
  try {
    const { limit, page, init, end, assistant_assistant_id } = req.query;
    const options = {};
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (limit !== undefined) {
      const lim = parseInt(limit, 10);
      if (isNaN(lim) || lim <= 0) {
        return res.status(400).json({ error: 'Parametro `limit` debe ser un entero positivo.' });
      }
      options.limit = lim;
    }
    if (page !== undefined) {
      const pg = parseInt(page, 10);
      if (isNaN(pg) || pg <= 0) {
        return res.status(400).json({ error: 'Parametro `page` debe ser un entero positivo.' });
      }
      options.page = pg;
    }
    if (init !== undefined) {
      if (!dateRegex.test(init)) {
        return res.status(400).json({ error: '`init` debe usar el formato YYYY-MM-DD.' });
      }
      options.init = init;
    }
    if (end !== undefined) {
      if (!dateRegex.test(end)) {
        return res.status(400).json({ error: '`end` debe usar el formato YYYY-MM-DD.' });
      }
      options.end = end;
    }
    if (options.init && options.end && new Date(options.init) > new Date(options.end)) {
      return res.status(400).json({ error: '`init` no puede ser posterior a `end`.' });
    }
    if (assistant_assistant_id) {
      options.assistantId = assistant_assistant_id;
    }
    const result = await getConversationsAdmin(pool, options);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(`${ROOT}/test_pii`, async (req, res) => {
  const texto = req.query.text || '';
  const options = {
    mode: 'json',
    pythonOptions: ['-u'],
    scriptPath: './',
    args: [texto]
  };
  try {
    const results = await PythonShell.run(
      '../../chatbot_functions/detectar_pii.py',
      options
    );
    res.json(results[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get(`${ROOT}/report/bizz/conversations/user_unique`, async (req, res) => {
  try {
	const {sub, bizz, scope} = req.user || null; //Parametro nuevo que debe ser agregado a la busqueda

	//const { id: bizz_id } = req.user.bizz || {};
	if (!bizz) {
		return res
		.status(400)
		.json({ error: 'Parametro bizz_id es obligatorio.' });
	}
	
    const conversations = await getUniqueUsersWithConversationCount(pool, bizz);
    res.status(200).json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Ruta: GET /user/configs  (usa el JWT para saber quÃ© usuario es) ---
app.get(`${ROOT}/platform/user/configs`, async (req, res) => {
  // req.user.sub es el user_id que firmamos en el JWT
  const { sub: user_id } = req.user || {};
  if (!user_id) {
    return res.status(400).json({ error: 'El Parametro user_id es obligatorio.' });
  }
  try {
    const result = await getAllUserConfigs(pool, user_id);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get(`${ROOT}/platform/bizz/configs`, async (req, res) => {
  const { sub: user_id, bizz: bizz_id } = req.user || {};

  if (!user_id) {
    return res.status(400).json({ error: 'El parámetro user_id es obligatorio.' });
  }

  if (!bizz_id) {
    return res.status(400).json({ error: 'El parámetro bizz_id es obligatorio.' });
  }

  try {
    const result = await getAllBizzConfigs(pool, user_id, bizz_id);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/user/channels-config
app.post(`${ROOT}/cloud/funcitons/message-recovery`, async (req, res) => {
	const { conversation_id, msg, assistant_id } = req.body;
	
	const { bizz: bizz_id } = req.user || {};
	console.log(bizz_id)
	
	const authHeader = req.headers.authorization;

	if (!authHeader) {
		return res.status(400).json({ error: 'Faltan datos obligatorios o token' });
	}
	
	const existingAssistantConfig = await getValidAssistantConfig(pool, bizz_id, assistant_id)
	
	console.log(existingAssistantConfig)
	  
	const existinguser = await getValidConversationForRecovery(pool, conversation_id)
	
	//if (existinguser) {
	if (existinguser!==null && existingAssistantConfig) {
		
		const configChannels = JSON.parse(existingAssistantConfig.channel_config)
	
		const whatsappToken = configChannels.whatsapp && configChannels.whatsapp!=='' ? decrypt(configChannels.whatsapp) : '';
		const facebookToken = configChannels.facebook && configChannels.facebook!=='' ? decrypt(configChannels.facebook) : '';
		const instagramToken = configChannels.instagram && configChannels.instagram!=='' ? decrypt(configChannels.instagram) : '';
		
		const whatsappUrl = configChannels.whatsapp_url && configChannels.whatsapp_url!=='' ? decrypt(configChannels.whatsapp_url) : '';
		const facebookUrl = configChannels.facebook_url && configChannels.facebook_url!=='' ? decrypt(configChannels.facebook_url) : '';
		const instagramUrl = configChannels.instagram_url && configChannels.instagram_url!=='' ? decrypt(configChannels.instagram_url) : '';
		
		/*console.log('configuracion de asistente', existingAssistantConfig)
		console.log('conversacion existente', existinguser)
		
		console.log('InstagramPrivate', instagramToken)
		console.log('FacebookFanPage', facebookToken)
		console.log('whatsapp', whatsappToken)
		
		console.log('instagramUrl', instagramUrl)
		console.log('facebookUrl', facebookUrl)
		console.log('instagramUrl', instagramUrl)*/
			
			const channel = existinguser.channel
		
			// ... (Tu cÃ³digo existente para enviar el mensaje y guardar los datos) ...
			const url = channel=='whatsapp' ? whatsappUrl: channel == 'FacebookFanPage' ? facebookUrl : channel == 'InstagramPrivate' ? instagramUrl: '';
			const accessTokenWS = channel=='whatsapp' ? whatsappToken: channel == 'FacebookFanPage' ? facebookToken : channel == 'InstagramPrivate' ? instagramToken: '';
			
			const finalOutMessage = msg
			
			const uuidRecovery = uuidv4();
		
			if(channel==='webchat'){
				console.log('webchat out message')
						
				insertMessageRecoveryToConversation(pool, conversation_id, finalOutMessage, uuidRecovery)
				.then(response => console.log(response))
				.catch(error => console.error(error));
							
				res.json({ data: finalOutMessage });
				return false;
			}
					
			if(channel=='whatsapp'){
						const data = {
							messaging_product: 'whatsapp',
							to: existinguser.user_id,
							type: 'text',
							text: {body: finalOutMessage,},
						};

						const headers = {
							'Authorization': `Bearer ${accessTokenWS}`,
							'Content-Type': 'application/json',
						};

						try {
							const response = await axios.post(url, data, { headers });

							insertMessageRecoveryToConversation(pool, existinguser.conversation_id, finalOutMessage, uuidRecovery)
							.then(response => console.log(response))
							.catch(error => console.error(error));

							res.json({ data: finalOutMessage });

						} catch (error) {
							console.error('Error sending message:', error.response ? error.response.data : error.message);
							res.json(error);
						}
			}else if(channel=='FacebookFanPage' || channel == 'InstagramPrivate'){
						const headers = {
							'Authorization': `Bearer ${accessTokenWS}`,
							'Content-Type': 'application/json',
						};

						// Paso 1: Fragmentar el mensaje
						const messageChunks = [];
						for (let i = 0; i < finalOutMessage.length; i += 1000) {
							messageChunks.push(finalOutMessage.slice(i, i + 1000));
						}

						// Paso 2: Crear funciÃ³n para envÃ­o secuencial de fragmentos
						const sendSequentialMessages = async () => {
							for (let i = 0; i < messageChunks.length; i++) {
								const data = {
									message: { text: messageChunks[i] },
									recipient: { id: existinguser.user_id }
								};

								try {
									const response = await axios.post(url, data, { headers });
									console.log(`Mensaje ${i + 1}/${messageChunks.length} enviado:`, response.data);
								} catch (error) {
									console.error(`Error al enviar mensaje ${i + 1}:`, error.response ? error.response.data : error.message);
									// Opcional: podrÃ­as abortar si un mensaje falla
								}
							}


							await insertMessageRecoveryToConversation(pool, existinguser.conversation_id, finalOutMessage, uuidRecovery)
								.then(response => console.log(response))
								.catch(error => console.error(error));

							res.json({ data: finalOutMessage }); // Devuelve el mensaje completo como confirmaciÃ³n
						};

						// Ejecutar envÃ­o en secuencia
						await sendSequentialMessages();
			}		
		
	}
});

app.post(`${ROOT}/cloud/funcitons/assistant-disabled`, async (req, res) => {
  const { conversation_id, assistant_id, assistant_disabled } = req.body;
  const { bizz: bizz_id } = req.user || {};

  if (!conversation_id || !assistant_id || typeof assistant_disabled !== 'boolean') {
    return res.status(400).json({
      error: 'Los campos conversation_id, assistant_id y assistant_disabled(boolean) son obligatorios'
    });
  }

  if (!bizz_id) {
    return res.status(400).json({ error: 'Parámetro bizz_id es obligatorio.' });
  }

  try {
    const existingAssistantConfig = await getValidAssistantConfig(pool, bizz_id, assistant_id);
    const existingConversation = await getValidConversationForRecovery(pool, conversation_id);

    if (!existingAssistantConfig) {
      return res.status(404).json({ error: 'Configuración de asistente no encontrada.' });
    }

    if (!existingConversation) {
      return res.status(404).json({ error: 'Conversación no encontrada.' });
    }

    if (
      existingConversation.assistant_assistant_id &&
      existingConversation.assistant_assistant_id !== assistant_id
    ) {
      return res.status(409).json({
        error: 'La conversación no corresponde al assistant_id indicado.'
      });
    }

    const updateQuery = `
      UPDATE gpt.conversations
      SET assistant_disabled = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE conversation_id = $2
      RETURNING conversation_id, assistant_assistant_id, assistant_disabled, updated_at
    `;

    const { rows } = await pool.query(updateQuery, [assistant_disabled, conversation_id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'No se pudo actualizar la conversación.' });
    }

    return res.status(200).json({
      message: 'assistant_disabled actualizado correctamente',
      data: rows[0]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post(`${ROOT}/cloud/functions/update-bizz-configs_intents_config_leads`, async (req, res) => {
  const { config } = req.body;
  const { bizz: bizz_id } = req.user || {};

  if (!bizz_id) {
    return res.status(400).json({ error: 'Parámetro bizz_id es obligatorio.' });
  }

  if (config === undefined) {
    return res.status(400).json({ error: 'El campo config es obligatorio.' });
  }

  try {
    const updateQuery = `
      UPDATE security.bizz_configs
      SET intents_config_leads = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE bizz_id = $2
      RETURNING id, bizz_id, intents_config_leads, updated_at
    `;

    const payload = typeof config === 'string' ? config : JSON.stringify(config);
    const { rows } = await pool.query(updateQuery, [payload, bizz_id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Configuración de bizz no encontrada.' });
    }

    return res.status(200).json({
      message: 'intents_config_leads actualizado correctamente',
      data: rows[0]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('API Cloud Service');
});






