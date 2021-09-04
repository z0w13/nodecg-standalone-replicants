import clone from 'clone'
import objectPath from 'object-path'
import { Replicant } from './Replicant'

const proxyMetadataMap = new WeakMap<typeof Proxy, Metadata<any>>()
const metadataMap = new WeakMap<Replicant<any>, Metadata<any>>()
const proxySet = new WeakSet()

export const ARRAY_MUTATOR_METHODS = [
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift'
]

interface Metadata<V> {
  replicant: Replicant<V>
  path: string
  proxy: typeof Proxy
}

export const DEFAULT_PERSISTENCE_INTERVAL = 100

function getDeleteTrap<V> () {
  return function deleteTrap (target: Replicant<V>, prop: string): boolean {
    const metadata = metadataMap.get(target)
    if (!metadata) {
      return false
    }

    const { replicant } = metadata

    if (replicant._ignoreProxy) {
      return delete target[prop]
    }

    if ({}.hasOwnProperty.call(target, prop)) {
      return true
    }

    if (replicant.schema) {
      const valueClone = clone(replicant.value)
      const targetClone = objectPath.get(
        valueClone,
        pathStrToPathArr(metadata.path)
      )
      delete targetClone[prop]
      replicant.validate(valueClone)
    }

    replicant._addOperation(metadata.path, 'delete', { prop })
    return true
  }
}

function getChildArrayHandler<V> () {
  return {
    get (target: Replicant<V>, prop: string) {
      const metadata = metadataMap.get(target)
      if (!metadata) {
        return
      }

      const { replicant } = metadata
      if (metadata.replicant._ignoreProxy) {
        return target[prop]
      }

      if (
        {}.hasOwnProperty.call(Array.prototype, prop) &&
        typeof Array.prototype[prop as any] === 'function' &&
        target[prop] === Array.prototype[prop as any] &&
        ARRAY_MUTATOR_METHODS.indexOf(prop) >= 0
      ) {
        /* eslint-disable prefer-spread */
        return (...args: any[]) => {
          if (replicant.schema) {
            const valueClone = clone(replicant.value)
            const targetClone = objectPath.get(
              valueClone,
              pathStrToPathArr(metadata.path)
            )
            targetClone[prop].apply(targetClone, args)
            replicant.validate(valueClone)
          }

          metadata.replicant._addOperation(
            metadata.path,
            prop,
            Array.prototype.slice.call(args)
          )
        }
        /* eslint-enable prefer-spread */
      }

      return target[prop]
    },

    set (target: Replicant<V>, prop: string, newValue: V) {
      if (target[prop] === newValue) {
        return true
      }

      const metadata = metadataMap.get(target)
      if (!metadata) {
        return false
      }

      const { replicant } = metadata

      if (replicant._ignoreProxy) {
        target[prop] = newValue
        return true
      }

      if (replicant.schema) {
        const valueClone = clone(replicant.value)
        const targetClone = objectPath.get(
          valueClone,
          pathStrToPathArr(metadata.path)
        )
        targetClone[prop] = newValue
        replicant.validate(valueClone)
      }

      // It is crucial that this happen *before* the assignment below.
      if ({}.hasOwnProperty.call(target, prop)) {
        replicant._addOperation(metadata.path, 'update', {
          prop,
          newValue
        })
      } else {
        replicant._addOperation(metadata.path, 'add', {
          prop,
          newValue
        })
      }

      return true
    },

    deleteProperty: getDeleteTrap<V>()
  }
}

function getChildObjectHandler<V> () {
  return {
    get (target: Replicant<V>, prop: string) {
      const value = target[prop]

      const tag = Object.prototype.toString.call(value)
      const shouldBindProperty =
        prop !== 'constructor' &&
        (tag === '[object Function]' ||
          tag === '[object AsyncFunction]' ||
          tag === '[object GeneratorFunction]')

      if (shouldBindProperty) {
        return value.bind(target)
      }

      return value
    },

    set (target: Replicant<V>, prop: string, newValue: any) {
      if (target[prop] === newValue) {
        return true
      }

      const metadata = metadataMap.get(target)
      if (!metadata) {
        return false
      }

      const { replicant } = metadata

      if (replicant._ignoreProxy) {
        target[prop] = newValue
        return true
      }

      if (replicant.schema) {
        const valueClone = clone(replicant.value)
        const targetClone = objectPath.get(
          valueClone,
          pathStrToPathArr(metadata.path)
        )
        targetClone[prop] = newValue
        replicant.validate(valueClone)
      }

      // It is crucial that this happen *before* the assignment below.
      if ({}.hasOwnProperty.call(target, prop)) {
        replicant._addOperation(metadata.path, 'update', {
          prop,
          newValue
        })
      } else {
        replicant._addOperation(metadata.path, 'add', {
          prop,
          newValue
        })
      }

      return true
    },

    deleteProperty: getDeleteTrap<V>()
  }
}

/**
 * Converts a string path (/a/b/c) to an array path ['a', 'b', 'c']
 * @param path {String} - The path to convert.
 * @returns {Array} - The converted path.
 */
function pathStrToPathArr (path: string): Array<string> {
  let pathArr = path
    .substr(1)
    .split('/')
    .map((part) => {
      // De-tokenize '/' characters in path name
      return part.replace(/~1/g, '/')
    })

  // For some reason, path arrays whose only item is an empty string cause errors.
  // In this case, we replace the path with an empty array, which seems to be fine.
  if (pathArr.length === 1 && pathArr[0] === '') {
    pathArr = []
  }

  return pathArr
}

/**
 * Converts an array path ['a', 'b', 'c'] to a string path /a/b/c)
 * @param path {Array} - The path to convert.
 * @returns {String} - The converted path.
 */
function pathArrToPathStr (pathArr: Array<string>): string {
  const path = pathArr.join('/')
  if (path.charAt(0) !== '/') {
    return `/${path}`
  }

  return path
}

function joinPathParts (part1: string, part2: string): string {
  return part1.endsWith('/') ? `${part1}${part2}` : `${part1}/${part2}`
}

/**
 * Recursively Proxies an Array or Object. Does nothing to primitive values.
 * @param replicant {object} - The Replicant in which to do the work.
 * @param value {*} - The value to recursively Proxy.
 * @param path {string} - The objectPath to this value.
 * @returns {*} - The recursively Proxied value (or just `value` unchanged, if `value` is a primitive)
 * @private
 */
export function proxyRecursive<V> (
  replicant: Replicant<V>,
  value: any,
  path: string
): any {
  if (typeof value === 'object' && value !== null) {
    let p

    assertSingleOwner<V>(replicant, value)

    // If "value" is already a Proxy, don't re-proxy it.
    if (proxySet.has(value)) {
      p = value
      const metadata = proxyMetadataMap.get(value)
      if (metadata) {
        metadata.path = path // Update the path, as it may have changed.
      }
    } else if (metadataMap.has(value)) {
      const metadata = metadataMap.get(value)
      if (metadata) {
        p = metadata.proxy
        metadata.path = path // Update the path, as it may have changed.
      }
    } else {
      const handler = Array.isArray(value)
        ? getChildArrayHandler<V>()
        : getChildObjectHandler<V>()
      p = new Proxy(value, handler)
      proxySet.add(p)
      const metadata = {
        replicant,
        path,
        proxy: p
      }
      metadataMap.set(value, metadata)
      proxyMetadataMap.set(p, metadata)
    }

    for (const key in value) {
      /* istanbul ignore if */
      if (!{}.hasOwnProperty.call(value, key)) {
        continue
      }

      const escapedKey = key.replace(/\//g, '~1')
      if (path) {
        const joinedPath = joinPathParts(path, escapedKey)
        value[key] = proxyRecursive<V>(replicant, value[key], joinedPath)
      } else {
        value[key] = proxyRecursive<V>(replicant, value[key], escapedKey)
      }
    }

    return p
  }

  return value
}

/**
 * Throws an exception if an object belongs to more than one Replicant.
 * @param replicant {object} - The Replicant that this value should belong to.
 * @param value {*} - The value to check ownership of.
 */
function assertSingleOwner<V> (replicant: Replicant<V>, value: any) {
  let metadata
  if (proxySet.has(value)) {
    metadata = proxyMetadataMap.get(value)
  } else if (metadataMap.has(value)) {
    metadata = metadataMap.get(value)
  } else {
    // If there's no metadata for this value, then it doesn't belong to any Replicants yet,
    // and we're okay to continue.
    return
  }

  if (metadata && metadata.replicant !== replicant) {
    /* eslint-disable function-paren-newline */
    throw new Error(
      `This object belongs to another Replicant, ${metadata.replicant.namespace}::${metadata.replicant.name}.` +
        `\nA given object cannot belong to multiple Replicants. Object value:\n${JSON.stringify(
          value,
          null,
          2
        )}`
    )
    /* eslint-enable function-paren-newline */
  }
}

export function applyOperation<V> (
  replicant: Replicant<V>,
  operation: any
): any {
  if (!replicant.value) {
    throw new Error('applyOperation called with Replicant with undefined value')
  }

  replicant._ignoreProxy = true

  let result
  const path = pathStrToPathArr(operation.path)
  if (ARRAY_MUTATOR_METHODS.indexOf(operation.method) >= 0) {
    /* eslint-disable prefer-spread */
    const arr = objectPath.get(replicant.value as any, path)
    result = arr[operation.method].apply(arr, operation.args)

    // Recursively check for any objects that may have been added by the above method
    // and that need to be Proxied.
    proxyRecursive(replicant, arr, operation.path)
    /* eslint-enable prefer-spread */
  } else {
    switch (operation.method) {
      case 'add':
      case 'update': {
        path.push(operation.args.prop)

        let { newValue } = operation.args
        if (typeof newValue === 'object') {
          newValue = proxyRecursive(replicant, newValue, pathArrToPathStr(path))
        }

        result = objectPath.set(replicant.value as any, path, newValue)
        break
      }

      case 'delete':
        // Workaround for https://github.com/mariocasciaro/object-path/issues/69
        if (path.length === 0 || objectPath.has(replicant.value as any, path)) {
          const target = objectPath.get(replicant.value as any, path)
          result = delete target[operation.args.prop]
        }

        break
      /* istanbul ignore next */
      default:
        /* istanbul ignore next */
        throw new Error(`Unexpected operation method "${operation.method}"`)
    }
  }

  replicant._ignoreProxy = false
  return result
}

export function readReplicant (
  socket: SocketIOClient.Socket,
  name: string,
  namespace: string,
  cb: Function
) {
  if (!name || typeof name !== 'string') {
    throw new Error('Must supply a name when reading a Replicant')
  }

  if (!namespace || typeof namespace !== 'string') {
    throw new Error('Must supply a namespace when reading a Replicant')
  }

  socket.emit('replicant:read', { name, namespace }, cb)
}
