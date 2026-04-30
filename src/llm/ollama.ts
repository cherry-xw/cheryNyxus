import { ChatOllama } from "@langchain/ollama"
import config from '../config.ts'
console.log(config);
export const ollama = new ChatOllama(config.models.ollama)