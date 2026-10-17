// pnpm selfimprove:smoke: confirms the key, lists Nemotron models, and makes one chat call per configured model.
import { CrusoeClient, loadCrusoeConfig } from './crusoe.ts';

const cfg = loadCrusoeConfig();
const client = new CrusoeClient(cfg);

const models = await client.listModels();
const nemotron = models.filter((m) => /nemotron/i.test(m));
console.log(`${models.length} models available; Nemotron: ${nemotron.join(', ') || '(none)'}`);

for (const [role, model] of [['fast', cfg.fastModel], ['strong', cfg.strongModel]] as const) {
  if (!models.includes(model)) {
    console.log(`${role}: ${model} is NOT in the live model list. Set CRUSOE_MODEL_${role.toUpperCase()} to one of the IDs above.`);
    continue;
  }
  const r = await client.chat({ model, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], maxTokens: 64, temperature: 0 });
  console.log(`${role}: ${model} -> ${JSON.stringify(r.text.trim().slice(0, 80))} (${r.latencyMs} ms, ${r.promptTokens ?? '?'}+${r.completionTokens ?? '?'} tokens)`);
}
