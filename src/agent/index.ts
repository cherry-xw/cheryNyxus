import { sendMessage } from '../llm/ollama.ts';

async function main() {
  console.log('Sending hello message to ollama...');

  try {
    const response = await sendMessage('hello');
    console.log('Response from ollama:', response);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();