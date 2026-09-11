import { createMemoryStore, createStore } from '../src/store.ts'
import { runStoreContract } from './store.contract.ts'

runStoreContract('memory', async () => createMemoryStore())

runStoreContract('sqlite (:memory:)', async () => createStore('sqlite::memory:'))
