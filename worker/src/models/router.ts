/*
  Model router: elige el adaptador según la configuración del agente del cliente,
  descifra la API key solo en memoria y aplica el respaldo a los modelos hosted (ver HOSTED_FALLBACKS).
*/
import type { Env } from '../env'
import { decryptForTenant } from '../auth/crypto'
import { PlatformRepo } from '../db/platform-repo'
import type { TenantRepo } from '../db/tenant-repo'
import { HOSTED_DEFAULT_MODEL, HOSTED_FALLBACKS, RETIRED_HOSTED } from '../db/seed'
import { parseJson, type AgentRow, type ModelRow, type TenantRow } from '../db/types'
import { anthropic, fakeProvider, openaiLike, workersAi } from './adapters'
import { ProviderError, type Credentials, type ModelProvider } from './provider'

export interface Resolved {
  model: ModelRow
  provider: ModelProvider
  modelName: string
  creds: Credentials
}

export function providerFor(env: Env, p: ModelRow['provider']): ModelProvider {
  const fake = env.DEV_FAKE_AI === 'true'
  switch (p) {
    case 'workers-ai':
      return fake ? fakeProvider('workers-ai') : workersAi(env)
    case 'anthropic':
      return fake ? fakeProvider('claude') : anthropic()
    case 'openai':
      return fake ? fakeProvider('openai') : openaiLike('openai')
    case 'openai-compatible':
      return openaiLike('openai-compatible')
  }
}

/** Modelos hosted a probar después de que `failedId` falló (sin repetir el que falló) */
export function hostedFallbacksAfter(failedId: string): string[] {
  return HOSTED_FALLBACKS.filter((id) => id !== failedId)
}

export function enabledModels(tenant: TenantRow): string[] {
  return parseJson<string[]>(tenant.enabled_models, [])
}

/**
 * Elige el modelo del agente.
 * - forceHosted: ignora el modelo del agente y usa el hosted por defecto (respaldo de BYOK y análisis).
 * - hostedId: usa ese modelo hosted (cadena de respaldo cuando un hosted falla).
 */
export async function resolveModel(env: Env, repo: TenantRepo, tenant: TenantRow, agent: AgentRow, forceHosted = false, hostedId?: string): Promise<Resolved> {
  const platform = new PlatformRepo(env.DB)
  const enabled = enabledModels(tenant)
  const wanted = hostedId ?? (forceHosted ? null : RETIRED_HOSTED[agent.model_id] ?? agent.model_id)
  let model = wanted ? await platform.model(wanted) : null
  if (model && !hostedId && (!model.active || (enabled.length && !enabled.includes(model.id)))) model = null
  if (model && hostedId && (!model.active || model.type !== 'hosted')) model = null
  if (!model) {
    model = await platform.model(HOSTED_DEFAULT_MODEL)
    if (!model) throw new ProviderError('unavailable', 'No hay modelo disponible.')
  }
  if (model.type === 'hosted') return { model, provider: providerFor(env, model.provider), modelName: model.model_name, creds: {} }

  const key = agent.provider_key_id ? await repo.providerKeyWithSecret(agent.provider_key_id) : await repo.providerKeyFor(model.provider)
  if (!key || key.provider !== model.provider) throw new ProviderError('auth', `Falta la API key de ${model.display_name}.`)
  if (!tenant.data_key_enc) throw new ProviderError('auth', 'El cliente no tiene llave de cifrado.')
  const apiKey = await decryptForTenant(env, tenant.id, tenant.data_key_enc, key.id, key.secret_enc)
  const modelName = model.provider === 'openai-compatible' ? key.model_name || model.model_name : model.model_name
  if (!modelName) throw new ProviderError('bad_request', 'Falta el nombre del modelo del proveedor compatible.')
  return { model, provider: providerFor(env, model.provider), modelName, creds: { apiKey, baseUrl: key.base_url ?? undefined } }
}
