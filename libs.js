'use strict'
const paths = require('path')
const buck = require('./buck')
const ops = require('./ops')
const mvn = require('./mvn')
const lock = require('./lock')

const GEN_BANNER = '# Generated by up.js --lib, do not edit, manual edits will be overridden'

class Lib {
  constructor(target, jars, srcs, options) {
    Object.assign(this, {
      target,
      jars,
      srcs,
      options,
    })
  }

  get path() {
    return this.target.path
  }

  get name() {
    return `//${this.target.abbr}`
  }

  get flatname() {
    return this.name.replace(/[-.:/]/g, '_')
  }

  symlinkJar(jar) {
    return paths.join(this.path, '.out', `${jar.filenameJar}`)
  }

  symlinkSrc(jar) {
    return paths.join(this.path, '.out', `${jar.filenameSrc}`)
  }

  toBuckRules() {
    return buck.rules(this.target, this.jars, this.srcs, this.options)
  }

  toString() {
    return `${this.name} [${this.jars.join(' ')}]`
  }
}

Lib.fromRaw = function(target, jars, options) {
  options = options || {}
  let toCoords = j => mvn.coords(j, options)
  jars = [].concat(jars).map(toCoords)
  let srcs = options.srcs && [].concat(options.srcs).map(toCoords)

  if (srcs
      && srcs.length > 0
      && srcs.length !== jars.length) {
    throw `Library ${target}, 'options.srcs' are not matching number or jars`
  }

  return new Lib(
    buck.target(target),
    jars,
    srcs || jars,
    options || {})
}

module.exports = {
  includes: [],
  staged: [],
  all: [],
  byTarget: {},
  byPath: {},

  toString() {
    return ['Libraries', ...this.all].map(String).join('\n\t')
  },

  include(requirePath) {
    this.includes.push(requirePath)
  },

  prepare() {
    if (this.all.length) return

    lock.load()
        .map(([...args]) => Lib.fromRaw(...args))
        .forEach(l => this.add(l))
  },

  uplock() {
    if (this.all.length) {
      ops.err('intenal problem: libraries already defined')
      return
    }
    if (lock.exists()) {
      // Load from lockfile to cache known checksums,
      // however we are not applying libraries from lockfile
      // by discarding the result
      lock.load()
    }
    // here we process delayed includes, because those includes may
    // not be available yet as files when commands like `up --grab`
    // is executed to actually download these
    // please take a note, that we only allow `.lib()` directives in included
    // library scripts, not the full set directives on `up` object
    // we do look at includes when regenerating libraries/lock file
    // and ignore those includes when just redoing libraries from lock etc
    for (let p of this.includes) {
      require(p)({ lib: (...args) => this.stage(...args) })
    }
    this.includes = []

    this.staged.forEach(l => this.add(l))
    lock.store(this.staged)
  },

  stage(...args) {
    this.staged.push(Lib.fromRaw(...args))
  },

  add(lib) {
    this.all.push(lib)
    this.addByTarget(lib)
    this.addByPath(lib)
  },

  addByTarget(lib) {
    let k = String(lib.target)
    if (k in this.byTarget) throw `Duplicate library ${k}`
    this.byTarget[k] = lib
  },

  addByPath(lib) {
    let d = this.byPath
    ;(d[lib.path] || (d[lib.path] = [])).push(lib)
  },

  genBuckfiles() {
    for (let [path, ls] of Object.entries(this.byPath)) {
      ops.write(
          paths.join(path, 'BUCK'),
          [GEN_BANNER, ...ls.flatMap(l => l.toBuckRules())].join(''))
    }
    // we've written some BUCK files so make sure we
    // will re-query buck
    buck.dropCache()
  },
}
