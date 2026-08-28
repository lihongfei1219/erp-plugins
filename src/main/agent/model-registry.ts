import {
  createModels,
  createProvider,
  type Model,
  type MutableModels
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { PiAgentConfig, PiModelEndpointConfig } from './config'

type OpenAiCompatibleModel = Model<'openai-completions'>

export interface PiModelRegistry {
  models: MutableModels
  ocrModel: OpenAiCompatibleModel
  normalizerModel: OpenAiCompatibleModel
}

function modelFromConfig(config: PiModelEndpointConfig): OpenAiCompatibleModel {
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: config.supportsImages ? ['text', 'image'] : ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens
  }
}

function registerEndpoint(
  models: MutableModels,
  config: PiModelEndpointConfig
): OpenAiCompatibleModel {
  const model = modelFromConfig(config)
  models.setProvider(
    createProvider<'openai-completions'>({
      id: config.providerId,
      name: config.providerId,
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: `${config.providerId} API key`,
          check: async () => ({ type: 'api_key', source: config.apiKey ? 'environment' : 'keyless' }),
          resolve: async () => ({
            auth: { apiKey: config.apiKey || 'not-required' },
            source: config.apiKey ? 'environment' : 'keyless'
          })
        }
      },
      models: [model],
      api: openAICompletionsApi()
    })
  )
  return model
}

export function createPiModelRegistry(config: PiAgentConfig): PiModelRegistry {
  const models = createModels()
  const ocrModel = registerEndpoint(models, config.ocr)
  const normalizerModel = registerEndpoint(models, config.normalizer)
  return { models, ocrModel, normalizerModel }
}
