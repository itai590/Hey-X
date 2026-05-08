'use strict';

/**
 * Runtime tweak: YAML lists training endpoints under `bearerTrainingAuth`; we serve a single
 * `bearerMainAuth` scheme so Swagger shows one authorize dialog (main admin token).
 */

function replaceSecuritySchemeRefs(node, fromScheme, toScheme) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => replaceSecuritySchemeRefs(item, fromScheme, toScheme));
    return;
  }
  if (Object.prototype.hasOwnProperty.call(node, fromScheme)) {
    node[toScheme] = node[fromScheme];
    delete node[fromScheme];
  }
  Object.values(node).forEach((value) => replaceSecuritySchemeRefs(value, fromScheme, toScheme));
}

function collapseSecurityScheme(spec, fromScheme, toScheme) {
  if (!spec || typeof spec !== 'object') return;
  replaceSecuritySchemeRefs(spec.paths, fromScheme, toScheme);
  if (spec.components && spec.components.securitySchemes) {
    delete spec.components.securitySchemes[fromScheme];
  }
}

module.exports = { collapseSecurityScheme };
