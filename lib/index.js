const loaderUtils = require('loader-utils');
const merge = require('deep-extend');
const mapBuilder = require('./dependency-map-builder');
const { SourceNode } = require('source-map');
const { SourceMapConsumer } = require('source-map');

const defaultConfig = {
    paths: [],
    es6mode: false,
    watch: true,
    fileExt: '.js',
};

/**
 * Escape a string for usage in a regular expression
 *
 * @param {string} string
 * @returns {string}
 */
function escapeRegExp(string) {
    return string.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1');
}

/**
 * Replace a given goog.require() with a CommonJS require() call.
 *
 * @param {object} loader
 * @param {string} source
 * @param {string} key
 * @param {string} search
 * @param {Object} provideMap
 * @returns {string}
 */
function replaceRequire(loaderContext, source, key, search, provideMap) {
    const replaceRegex = new RegExp(escapeRegExp(search), 'g');

    if (!provideMap[key]) {
        throw new Error(`Can't find closure dependency ${key}`);
    }

    const path = loaderUtils.stringifyRequest(loaderContext, provideMap[key]);
    const requireString = `require(${path}).${key}`;

    return source.replace(
        replaceRegex,
        `__exportPath(__closureLoaderNamespace,'${key}',${requireString});`,
    );
}

/**
 * Array filter function to remove duplicates
 *
 * @param {string} key
 * @param {number} idx
 * @param {Array} arr
 * @returns {boolean}
 */
function deduplicate(key, idx, arr) {
    return arr.indexOf(key) === idx;
}

/**
 * Creates a function that extends an object based on an array of keys
 *
 * Example: `['abc.def', 'abc.def.ghi', 'jkl.mno']` will become `{abc: {def: {ghi: {}}, jkl: {mno: {}}}`
 *
 * @param {Object} tree - the object to extend
 * @returns {Function} The filter function to be called in forEach
 */
function buildVarTree(tree) {
    return function filter(key) {
        let layer = tree;
        key.split('.').forEach(part => {
            layer[part] = layer[part] || {};
            layer = layer[part];
        });
        return key;
    };
}

/**
 * Array filter function to remove vars which already have a parent exposed
 *
 * Example: Remove a.b.c if a.b exists in the array
 *
 * @param {[type]} key [description]
 * @param {[type]} idx [description]
 * @param {[type]} arr [description]
 *
 * @returns {[type]} [description]
 */
function removeNested(key, idx, arr) {
    let foundParent = false;

    key.split('.').forEach((subKey, subIdx, keyParts) => {
        if (subIdx === keyParts.length - 1) return;
        const parentKey = keyParts.slice(0, subIdx + 1).join('.');
        foundParent = foundParent || arr.indexOf(parentKey) >= 0;
    });

    return !foundParent;
}

/**
 * Create a string which will be injected after the actual module code
 *
 * This will create export statements for all provided namespaces as well as the default
 * export if es6mode is active.
 *
 * @param {Object} exportVarTree
 * @param {Array} exportedVars
 * @param {Object} config
 * @returns {string}
 */
function createPostfix(exportVarTree, exportedVars, config) {
    let postfix = '\n;';
    Object.keys(exportVarTree).forEach(rootVar => {
        postfix += `exports.${rootVar}=${rootVar};`;
    });

    if (config.es6mode && exportedVars.length) {
        postfix += `exports.default=${exportedVars.shift()};exports.__esModule=true;`;
    }

    return postfix;
}

/**
 * Create a string to inject before the actual module code
 *
 * This will create all provided or required namespaces. It will merge those namespaces into an existing
 * object if existent.
 *
 * @param loaderContext
 * @param globalVarTree
 * @param globalVars
 * @returns {string}
 */
function createPrefix(loaderContext, globalVarTree, globalVars) {
    let prefix = '';
    prefix += `var __exportPath=require(${loaderUtils.stringifyRequest(
        loaderContext,
        require.resolve('./export-path.js'),
    )});`;
    prefix += 'window.__closureLoaderNamespace || (window.__closureLoaderNamespace = {});';
    Object.keys(globalVarTree).forEach(rootVar => {
        prefix += `var ${rootVar} = __closureLoaderNamespace.${rootVar} || (__closureLoaderNamespace.${rootVar} = window.${rootVar} || {});`;
    });

    prefix += `${JSON.stringify(
        globalVars,
    )}.forEach(function(n){ __exportPath(__closureLoaderNamespace, n); });`;

    return prefix;
}

module.exports = function loader(originalSource, inputSourceMap) {
    const self = this;
    const callback = this.async();
    let source = originalSource;
    let globalVars = [];
    let exportedVars = [];

    if (this.cacheable) {
        this.cacheable();
    }

    const options = loaderUtils.getOptions(this);
    const config = merge(
        {},
        defaultConfig,
        this.options
            ? this.options[(options && options.config) || 'closureLoader']
            : {},
        options,
    );

    mapBuilder(config.paths, config.watch, config.fileExt)
        .then(provideMap => {
            const provideRegExp = /goog\.provide *?\((['"])(.*?)\1\);?/;
            const requireRegExp = /goog\.require *?\((['"])(.*?)\1\);?/;
            const globalVarTree = {};
            const exportVarTree = {};

            let provideMatches = provideRegExp.exec(source);
            let requireMatches = requireRegExp.exec(source);

            if (!provideMatches && !requireMatches) {
                callback(null, source, inputSourceMap);
                return;
            }

            while (provideMatches) {
                source = source.replace(
                    new RegExp(escapeRegExp(provideMatches[0]), 'g'),
                    '',
                );
                globalVars.push(provideMatches[2]);
                exportedVars.push(provideMatches[2]);
                provideMatches = provideRegExp.exec(source);
            }

            while (requireMatches) {
                globalVars.push(requireMatches[2]);
                source = replaceRequire(
                    self,
                    source,
                    requireMatches[2],
                    requireMatches[0],
                    provideMap,
                );
                requireMatches = requireRegExp.exec(source);
            }

            globalVars = globalVars
                .filter(deduplicate)
                .map(buildVarTree(globalVarTree));

            exportedVars = exportedVars
                .filter(deduplicate)
                .filter(removeNested)
                .map(buildVarTree(exportVarTree));

            const prefix = createPrefix(
                self,
                globalVarTree,
                globalVars
            );
            const postfix = createPostfix(exportVarTree, exportedVars, config);

            if (inputSourceMap) {
                const currentRequest = loaderUtils.getCurrentRequest(self);
                const node = SourceNode.fromStringWithSourceMap(
                    originalSource,
                    new SourceMapConsumer(inputSourceMap),
                );

                node.prepend(`${prefix}\n`);
                node.add(postfix);
                const result = node.toStringWithSourceMap({
                    file: currentRequest,
                });

                callback(
                    null,
                    `${prefix}\n${source}${postfix}`,
                    result.map.toJSON(),
                );
                return;
            }

            callback(null, `${prefix}\n${source}${postfix}`, inputSourceMap);
        })
        .catch(error => {
            callback(error);
        });
};
