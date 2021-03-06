'use strict'

const ops = require('./ops')
const buck = require('./buck')
const mods = require('./mods')
const libs = require('./libs')

const env = {
  username: 'PUBLISH_USERNAME',
  password: 'PUBLISH_PASSWORD',
  repository: 'PUBLISH_REPOSITORY',
}

const outDir = '.out'
const localRepo = `file://${outDir}`
const repository = (process.env[env.repository] || '').replace(/\/$/, '')
const kvSamePlaceholder = '<&>'
const javaRules = {java_library: true, kotlin_library: true}
const stringsArrayKeys = {deps:true, exclude:true, content:true}

const stagedDirs = []
let dirs, conf, artifacts

class Zip {

  constructor(dir, options) {
    this.dir = dir
    this.options = options
  }

  get version() {
    let v = version()
    return v ? '-' + v : ''
  }

  get filename() {
    return `${this.dir}${this.version}.zip`
  }

  get repositoryPath() {
    return `${repositoryPath()}/${this.dir}/${version()}`
  }

  get archive() {
    // putting it under repositoryPath in outDir doesn't work with zip for some reason
    return `${outDir}/${this.filename}`
  }

  push() {
    upload(this.archive, `${this.repositoryPath}/${this.filename}`)
  }

  pack() {
    let content = [].concat(this.options.content || this.dir).join(' ')
    let exclude = [].concat(this.options.exclude || []).map(x => `-x '${x}'`).join(' ')

    ops.unlink(this.archive)

    ops.exec(`zip -r ${this.archive} ${content} ${exclude}`)
  }

  toString() {
    let opts = options(this.options)
        .replace(/\n/g, ' ')
        .replace(/,\s+([\}\]])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()

    return `${this.dir}.zip${opts})`
  }
}

function version() {
  return conf['maven.publish_ver']
}

function repositoryPath() {
  return conf['maven.publish_group'].replace(/\./g, '/')
}

function zip(dir, options) {
  options = options || {}
  stagedDirs.push(new Zip(trimSlashes(dir), options))
}

function upload(file, repositoryFilename) {
  if (!repository) return

  let sha1 = ops.exec(`shasum -a 1 ${file} | awk '{ print $1 }'`).trim()

  ops.exec(`curl --fail \
--connect-timeout ${ops.use.timeout} \
-u $${env.username}:$${env.password} \
-H "X-Checksum-Sha1:${sha1}" \
-X PUT "${repository}/${repositoryFilename}" \
-T "${file}"`)
}

function exportLibraries() {
  let defs = libs.all.map(a => `
    .lib('${a.target}', ${strings(a.jars)}${options(a.options)})`)

  let content = `// Generated by 'node up --publish'
module.exports = function(define, options) {
  const {repo} = options || {}
  define${defs.join('')}
}
`
  ops.write(`${outDir}/thirdparty-${version()}.js`, content)
}

function exportModules() {
  let defs = artifacts.map(a => `
    .lib('${targetOf(a)}', ${strings(jarOf(a))}${options(optionsOf(a))})`)

  let content = `// Generated by 'node up --publish'
module.exports = function(define, options) {
  const {repo} = options || {}
  define${defs.join('')}
}
`
  ops.write(`${outDir}/artifacts-${version()}.js`, content)
}

function uploadJs() {
  let v = version(),
      p = repositoryPath()
  upload(
      `${outDir}/thirdparty-${v}.js`,
      `${p}/thirdparty/${v}/thirdparty-${v}.js`)
  upload(
      `${outDir}/artifacts-${v}.js`,
      `${p}/artifacts/${v}/artifacts-${v}.js`)
}

function optionsOf(a) {
  // not sure this is best or correct set of dependencies
  let deps = buck.query(`deps('${targetOf(a)}', 1, first_order_deps())`)
  if (deps.length) return { deps, repo: kvSamePlaceholder }
  return {}
}

function targetOf(a) { return a[buck.attr.qname] }

function jarOf(a) { return a[buck.attr.mavenCoords] }

function ruleOf(a) { return a[buck.attr.type] }

function quote(a) { return `'${a}'` }

function options(o) {
  let ks = Object.keys(o)
  if (!ks.length) return ''
  let attrs = []
  for (let k of ks) {
    let v = k in stringsArrayKeys ? strings(o[k], '  ') : JSON.stringify(o[k])
    if (v == `"${kvSamePlaceholder}"`) attrs.push(`
      ${k},`)
    else attrs.push(`
      ${k}: ${v},`)
  }
  return `, {${attrs.join('')}
    }`
}

function strings(strings, indent) {
  strings = [].concat(strings)
  if (strings.length < 2) return quote(strings[0])
  let elements = strings.map(s => `
      ${indent || ''}${quote(s)},`)
  return `[${elements.join('')}
    ${indent || ''}]`
}

function prepare() {
  if (dirs) return // noop if already consumed stagesDir

  dirs = stagedDirs
  conf = JSON.parse(ops.exec(`buck audit config maven --json`))
  // Only jars we want to publish will end up here
  // we will not pickup generated libraries here as thay have
  // maven_coords on a prebuilt_jar rule, not on a corresponding java_library
  artifacts = buck.info(`//...`)
      .filter(t => ruleOf(t) in javaRules && jarOf(t))
}

function trimSlashes(path) {
  return path.replace(/^[/]+/, '').replace(/[/]+$/, '')
}

function publishArtifacts() {
  // store it in local repo for inspection in case of failure
  for (let t of artifacts) {
    ops.lesser(ops.exec(`buck publish ${targetOf(t)} \
--remote-repo ${localRepo}`))
  }
  if (!repository) return
  for (let t of artifacts) {
    ops.lesser(ops.exec(`buck publish ${targetOf(t)} \
--username $${env.username} \
--password $${env.password} \
--remote-repo $${env.repository}`))
  }
}

function publish() {
  ops.mkdirs(outDir)

  exportLibraries()
  exportModules()

  if (!repository) {
    // same check is performed for each artifact/archive to noop sending files
    // after those generated, but we warn/info it just once
    ops.err(`${env.repository} env variable is not set, skipping publishing to remote repository`)
  }

  // console.log(ops.exec(`echo "${env.username}=$${env.username} ${env.password}=$${env.password} ${env.repository}=$${env.repository}"`))
  uploadJs()

  dirs.forEach(d => d.pack())
  publishArtifacts()
  dirs.forEach(d => d.push())
}

module.exports = {
  prepare, zip, publish,

  toString() {
    return [
        'Artifacts',
        ...artifacts.map(t => '\t' + targetOf(t) + ' [' + jarOf(t) + ']'),
        'Archives',
        ...dirs.map(d => '\t' + d)
    ].join('\n')
  }
}
