import validator from 'is-my-json-valid'
import EventEmitter from 'events'
import clone from 'clone'
import equal from 'deep-equal'
import debug from 'debug'

import type {
  ReplicantOptions,
  OperationQueueItem
} from 'nodecg/types/lib/replicant'

import {
  DEFAULT_PERSISTENCE_INTERVAL,
  applyOperation,
  readReplicant,
  proxyRecursive
} from './shared'

type Status = 'undeclared' | 'declaring' | 'declared'

type RejectEventType =
  | 'operationsRejected'
  | 'assignmentRejected'
  | 'declarationRejected'

type DeclareEventType = 'declared' | 'fullUpdate'

type ChangeEventType = 'change'

type NewListenerEventType = 'newListener'

type EventType =
  | RejectEventType
  | DeclareEventType
  | ChangeEventType
  | NewListenerEventType

type ChangeListener<V> = (
  newValue: V,
  oldValue: V,
  dataOperations: any[]
) => void
type DeclaredListener<V> = (data: V) => void
type RejectListener = (rejectReason: any) => void
type NewListenerListener<V> = (
  event: EventType,
  listener: EventListener<V>
) => void

type EventListener<V> =
  | ChangeListener<V>
  | DeclaredListener<V>
  | RejectListener
  | NewListenerListener<V>

const declaredReplicants: Record<string, Record<string, Replicant<any>>> = {}

function getReplicantHandler<V> (): object {
  return {
    get (target: Replicant<V>, prop: string) {
      if (prop === 'value' && target.status !== 'declared') {
        console.warn(
          'Attempted to get value before Replicant had finished declaring. ' +
            'This will always return undefined.'
        )
      }

      return target[prop]
    },
    set (target: Replicant<V>, prop: string, newValue: V) {
      if (prop !== 'value' || target._ignoreProxy) {
        target[prop] = newValue
        return true
      }

      if (newValue === target[prop]) {
        console.debug('value unchanged, no action will be taken')
        return true
      }

      target.validate(newValue)

      if (target.status !== 'declared') {
        target._queueAction(target._proposeAssignment, [newValue])
        return true
      }

      target._proposeAssignment(newValue)
      return true
    }
  }
}

export class Replicant<V> extends EventEmitter {
  public name: string
  public namespace: string

  public value?: V
  public opts: ReplicantOptions<V>
  public revision: number

  public status: Status

  protected _operationQueue: Array<OperationQueueItem>
  protected _actionQueue: Array<any>

  protected _socket: any
  public schema: any
  public schemaSum: string = ''
  public validationErrors: ReturnType<typeof validator>['errors'] = []

  protected _validator?: ReturnType<typeof validator>
  protected log: debug.Debugger

  constructor (
    name: string,
    namespace: string,
    opts: ReplicantOptions<V>,
    socket: SocketIOClient.Socket
  ) {
    super()

    this.name = name
    this.namespace = namespace
    this.opts = opts
    this.value = undefined
    this.revision = 0
    this.status = 'undeclared'
    this._socket = socket
    this._actionQueue = []
    this._operationQueue = []
    this.log = debug(`nodecg:replicant:${namespace}.${name}`)

    if ({}.hasOwnProperty.call(declaredReplicants, namespace)) {
      if ({}.hasOwnProperty.call(declaredReplicants[namespace], name)) {
        return declaredReplicants[namespace][name]
      }
    } else {
      declaredReplicants[namespace] = {}
    }

    if (typeof opts.persistent === 'undefined') {
      opts.persistent = true
    }
    if (typeof opts.persistenceInterval === 'undefined') {
      opts.persistenceInterval = DEFAULT_PERSISTENCE_INTERVAL
    }

    this.on('newListener', (event: EventType, listener: EventListener<V>) => {
      if (event === 'change' && this.status === 'declared') {
        if (this.value) {
          const actualListener = listener as ChangeListener<V>
          actualListener(this.value, this.value, [])
        }
      }
    })

    this._declare()
    this.registerSocketOperations(socket)

    const proxy = new Proxy(this, getReplicantHandler<V>())
    declaredReplicants[namespace][name] = proxy
    return proxy
  }

  protected registerSocketOperations (socket: SocketIOClient.Socket) {
    socket.on('replicant:assignment', (data: any) =>
      this._handleAssignment(data)
    )
    socket.on('replicant:operations', (data: any) =>
      this._handleOperations(data)
    )
    socket.on('disconnect', () => this._handleDisconnect())
    socket.on('reconnect', () => this._declare())
  }

  public validate (
    value?: V,
    options: { throwOnInvalid: boolean } = { throwOnInvalid: true }
  ): boolean {
    if (!this._validator) {
      return true
    }

    const result = this._validator(value)
    if (!result) {
      this.validationErrors = this._validator.errors

      if (options.throwOnInvalid) {
        let errorMessage = `Invalid value rejected for replicant "${this.name}" in namespace "${this.namespace}":\n`
        this._validator.errors.forEach((error) => {
          const field = error.field.replace(/^data\./, '')
          if (error.message === 'is the wrong type') {
            errorMessage += `\tField "${field}" ${error.message}. Value "${
              error.value
            }" (type: ${typeof error.value}) was provided, expected type "${
              error.type
            }"\n `
          } else if (error.message === 'has additional properties') {
            errorMessage += `\tField "${field}" ${error.message}: "${error.value}"\n`
          } else {
            errorMessage += `\tField "${field}" ${error.message}\n`
          }
          throw new Error(errorMessage)
        })
      }

      return result
    }

    return true
  }

  public on(event: DeclareEventType, listener: DeclaredListener<V>): this
  public on(event: ChangeEventType, listener: ChangeListener<V>): this
  public on(event: RejectEventType, listener: RejectListener): this
  public on(event: NewListenerEventType, listener: NewListenerListener<V>): this
  public on (event: EventType, listener: EventListener<V>): this {
    if (event === 'change' && this.status === 'declared') {
      const actualListener = listener as ChangeListener<V>
      if (this.value) {
        actualListener(this.value, this.value, [])
      }
    }
    EventEmitter.prototype.on.call(this, event, listener)
    return this
  }

  public _queueAction (fn: Function, args: any[]): void {
    this._actionQueue.push({ fn, args })
  }

  public _proposeAssignment (newValue: V) {
    this._socket.emit(
      'replicant:proposeAssignment',
      {
        name: this.name,
        namespace: this.namespace,
        value: newValue,
        schemaSum: this.schemaSum,
        opts: this.opts
      },
      (data: any) => {
        if (data.schema) {
          this.schema = data.schema
          this.schemaSum = data.schemaSum
        }

        if (data.rejectReason) {
          if (this.listenerCount('assignmentRejected') > 0) {
            this.emit('assignmentRejected', data.rejectReason)
          } else {
            throw new Error(data.rejectReason)
          }
        }
      }
    )
  }

  public _declare () {
    if (this.status === 'declared' || this.status === 'declaring') {
      return
    }

    this.status = 'declaring'

    this._socket.emit('joinRoom', `replicant:${this.namespace}`, () => {
      this._socket.emit(
        'replicant:declare',
        {
          name: this.name,
          namespace: this.namespace,
          opts: this.opts
        },
        (data: any) => {
          if (data.rejectReason) {
            if (this.listenerCount('declarationRejected') > 0) {
              this.emit('declarationRejected', data.rejectReason)
            } else {
              throw new Error(data.rejectReason)
            }
          }

          this.log(
            'declareReplicant callback (value: %s, revision: %s)',
            data.value,
            data.revision
          )
          this.status = 'declared'

          /* If the revision we get in the response doesn't match the revision we have locally,
           * then we need to just assign the authoritative value we got back from the Replicator.
           * Likewise, if our local value isn't an exact match to what we got back from the Replicator,
           * just assume that the Replicator is correct and take the value it gave us.
           */
          if (
            this.revision !== data.revision ||
            !equal(this.value, data.value)
          ) {
            this._assignValue(data.value, data.revision)
          }

          if (data.schema) {
            this.schema = data.schema
            this.schemaSum = data.schemaSum
            this._validator = validator(this.schema)
          }

          // Let listeners know that this Replicant has been successfully declared.
          this.emit('declared', data)

          /* If a replicant is declared with no defaultValue and has not yet been given a value, then `change`
           * listeners added before declaration has completed will not fire when declaration completes, because
           * `undefined` === `undefined`, meaning that the above `_assignValue` call won't get run.
           *
           * To ensure consistent behavior, we manually emit a `change` event in this case.
           */
          if (this.value === undefined && this.revision === 0) {
            this.emit('change')
          }

          // If there were any pre-declare actions queued, execute them.
          if (this._actionQueue.length > 0) {
            this._actionQueue.forEach((item: any) => {
              item.fn.apply(this, item.args)
            })
            this._actionQueue = []
          }
        }
      )
    })
  }

  public _assignValue (newValue: V, revision?: number) {
    const oldValue = clone(this.value)

    this.value = proxyRecursive<V>(this, newValue, '/')

    if (typeof revision !== 'undefined') {
      this.revision = revision
    }

    this.emit('change', this.value, oldValue)
  }

  public _handleAssignment (data: any) {
    if (data.name !== this.name || data.namespace !== this.namespace) {
      return
    }

    this.log('received replicantAssigned', data)
    this._assignValue(data.newValue, data.revision)
  }

  _handleOperations (data: any) {
    if (this.status !== 'declared') {
      return
    }

    const expectedRevision = this.revision + 1
    if (data.name !== this.name || data.namespace !== this.namespace) {
      return
    }

    if (data.revision !== expectedRevision) {
      this.log(
        'Not at head revision (ours: "%s", expected theirs to be "%s" but got "%s"), fetching latest...',
        this.revision,
        expectedRevision,
        data.revision
      )
      this._fullUpdate()
      return
    }

    this.log('received replicantOperations', data)

    const oldValue = clone(this.value)
    data.operations.forEach((operation: any) => {
      operation.result = applyOperation(this, operation)
    })
    this.revision = data.revision
    this.emit('change', this.value, oldValue, data.operations)
  }

  _handleDisconnect () {
    this.status = 'undeclared'
    this._operationQueue.length = 0
    this._actionQueue.length = 0
  }

  private _fullUpdate () {
    readReplicant(this._socket, this.name, this.namespace, (data: any) => {
      this.emit('fullUpdate', data)
      this._assignValue(data.value, data.revision)
    })
  }

  static get declaredReplicants () {
    return declaredReplicants
  }

  [prop: string]: any
}
