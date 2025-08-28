/**
 * Cloudflare Worker that accepts JSON payloads, converts them to GELF format,
 * and forwards them to a Graylog HTTP GELF input.
 */

export interface Env {
	GRAYLOG_HOST: string;
	GRAYLOG_PORT: string;
	DEFAULT_SHORT_MESSAGE: string;
  }
  
  // GELF Message interface
  interface GELFMessage {
	version: string;
	host: string;
	short_message: string;
	timestamp: number;
	level?: number;
	full_message?: string;
	[key: string]: any; // For additional fields with underscore prefix
  }
  
  /**
   * Adds the parsed Message content to the GELF message
   * Handles nested objects by flattening them with dot notation
   */
  function addParsedMessageToGELF(gelfMessage: GELFMessage, parsedMessage: any, prefix: string = '_msg_') {
	for (const [key, value] of Object.entries(parsedMessage)) {
	  const fieldKey = `${prefix}${key}`;
	  
	  if (value === null || value === undefined) {
		// Skip null or undefined values
		continue;
	  } else if (typeof value === 'object' && !Array.isArray(value)) {
		// Recursively process nested objects with dot notation in the prefix
		addParsedMessageToGELF(gelfMessage, value, `${fieldKey}.`);
	  } else {
		// Add leaf values directly
		gelfMessage[fieldKey] = value;
	  }
	}
  }
  
  /**
   * Converts a JSON object to GELF format
   */
  function convertToGELF(data: any, env: Env): GELFMessage {
	// Check for required environment variables
	if (!env.DEFAULT_SHORT_MESSAGE) {
	  throw new Error('DEFAULT_SHORT_MESSAGE environment variable is not set');
	}
	
	// Create the base GELF message
	const gelfMessage: GELFMessage = {
	  version: '1.1',
	  host: data.host || 'cloudflare-worker',
	  short_message: data.message || env.DEFAULT_SHORT_MESSAGE,
	  timestamp: data.timestamp || Math.floor(Date.now() / 1000),
	};
  
	// Process the Message field if it exists and is a JSON string
	if (data.Message && typeof data.Message === 'string') {
	  try {
		const parsedMessage = JSON.parse(data.Message);
		
		// Add parsed Message fields to GELF with appropriate prefixes
		addParsedMessageToGELF(gelfMessage, parsedMessage);
	  } catch (error) {
		// If parsing fails, add the Message as a whole
		gelfMessage._raw_message = data.Message;
		gelfMessage._message_parse_error = error instanceof Error ? error.message : String(error);
	  }
	}
  
	// Add optional level field
	if (data.level !== undefined) {
	  gelfMessage.level = data.level;
	}
  
	// Add optional full_message field
	if (data.full_message) {
	  gelfMessage.full_message = data.full_message;
	}
  
	// Process all other fields and add them with underscore prefix if needed
	for (const [key, value] of Object.entries(data)) {
	  // Skip fields we've already processed
	  if (['host', 'message', 'timestamp', 'level', 'full_message', 'Message'].includes(key)) {
		continue;
	  }
  
	  // Add custom field with underscore prefix if it doesn't already have one
	  const fieldKey = key.startsWith('_') ? key : `_${key}`;
	  gelfMessage[fieldKey] = value;
	}
  
	return gelfMessage;
  }
  
  /**
   * Sends GELF data to a Graylog server
   */
  async function sendToGraylog(gelfData: GELFMessage, env: Env): Promise<Response> {
	// Check for required environment variables
	if (!env.GRAYLOG_HOST) {
	  throw new Error('GRAYLOG_HOST environment variable is not set');
	}
	if (!env.GRAYLOG_PORT) {
	  throw new Error('GRAYLOG_PORT environment variable is not set');
	}
	
	const graylogUrl = `http://${env.GRAYLOG_HOST}:${env.GRAYLOG_PORT}/gelf`;
	
	return fetch(graylogUrl, {
	  method: 'POST',
	  headers: {
		'Content-Type': 'application/json',
	  },
	  body: JSON.stringify(gelfData),
	});
  }
  
  export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	  // Only accept POST requests
	  if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 });
	  }
  
	  try {
		// Parse the incoming JSON payload
		const jsonData = await request.json();
  
		// Convert the JSON to GELF format
		const gelfData = convertToGELF(jsonData, env);
  
		// Send the GELF data to Graylog
		const graylogResponse = await sendToGraylog(gelfData, env);
  
		// Return response based on Graylog's response
		if (graylogResponse.ok) {
		  return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		  });
		} else {
		  const errorText = await graylogResponse.text();
		  return new Response(JSON.stringify({ 
			success: false, 
			error: `Graylog error: ${errorText}` 
		  }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		  });
		}
	  } catch (error) {
		// Handle any errors
		return new Response(JSON.stringify({ 
		  success: false, 
		  error: error instanceof Error ? error.message : String(error) 
		}), {
		  status: 400,
		  headers: { 'Content-Type': 'application/json' }
		});
	  }
	},
  };