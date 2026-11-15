import { emptyValidationState } from './validation/engine'
import type { ValidationState } from './validation/types'

// 校验链状态独立存放，和模块清单（lake-govern-config:entries）分开，
// 调整本地数据结构时不会冲掉业务清单，清单重置后由引擎幂等重建基线。
const VALIDATION_KEY = 'lake-govern-config:ingest-validation'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let validationCache: ValidationState | null = null

function readValidation(): ValidationState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return emptyValidationState()
  }
  const raw = window.localStorage.getItem(VALIDATION_KEY)
  if (!raw) {
    return emptyValidationState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ValidationState>
    return { ...emptyValidationState(), ...parsed }
  } catch {
    // 结构损坏时不污染业务清单，回到空状态后由 ensureBaseline 重新迁移。
    return emptyValidationState()
  }
}

export function getValidationState(): ValidationState {
  if (validationCache === null) {
    validationCache = readValidation()
  }
  return validationCache
}

export function saveValidationState(state: ValidationState): void {
  validationCache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(VALIDATION_KEY, JSON.stringify(state))
  }
}

export function resetValidationState(): ValidationState {
  const empty = emptyValidationState()
  saveValidationState(empty)
  return clone(empty)
}

export function validationStorageKey(): string {
  return VALIDATION_KEY
}
