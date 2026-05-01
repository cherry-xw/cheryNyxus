import {Ollama} from 'ollama';
import { config } from '../config.ts';

export async function sendMessage(message: string): Promise<string> {
  const ollamaConfig = config.llm.providers.ollama;
  const ollama = new Ollama({
    host: ollamaConfig.url as string
  });
  const response = await ollama.chat({
    model: ollamaConfig.model as string,
    messages: [{ role: 'user', content: message }],
  });

  return response.message.content;
}