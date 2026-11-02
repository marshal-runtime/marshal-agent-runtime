import assert from 'node:assert/strict';
import test from 'node:test';
import * as runtimeExtensions from '@marshal/runtime/extensions';

test('re-exports extension authoring helpers from the public runtime extensions subpath', () => {
  assert.equal(
    runtimeExtensions.RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
    Symbol.for('@marshal/agent-runtime-extensions:lifecycle'),
  );
  assert.equal(
    runtimeExtensions.RUNTIME_EXTENSION_CATALOG_SOURCE,
    Symbol.for('@marshal/agent-runtime-extensions:catalog-source'),
  );
  assert.equal(
    runtimeExtensions.RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
    Symbol.for('@marshal/agent-runtime-extensions:ui-publication'),
  );
  assert.equal(typeof runtimeExtensions.RuntimeExtensionManager, 'function');
  assert.equal(typeof runtimeExtensions.RuntimeExtensionUiPublicationRegistry, 'function');
  assert.equal(typeof runtimeExtensions.createTypeScriptExtensionAuthoringService, 'function');
  assert.equal(typeof runtimeExtensions.createTypeScriptExtensionAuthoringBundle, 'function');
  assert.equal(typeof runtimeExtensions.createTypeScriptExtensionAuthoringProvider, 'function');
});
