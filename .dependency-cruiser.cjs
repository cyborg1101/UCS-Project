module.exports = {
  forbidden: [
    {
      name: 'no-module-to-module-except-public',
      severity: 'error',
      comment:
        'A module may only be consumed through its *.public.ts facade. Importing internal files creates hidden coupling (Phase0 K01-T01 / K-15 check:boundaries).',
      from: { path: '^libs/modules/([^/]+)/' },
      to: {
        path: '^libs/modules/([^/]+)/',
        pathNot: ['^libs/modules/$1/', '\\.public\\.ts$', '^libs/modules/[^/]+/src/index\\.ts$'],
      },
    },
    {
      name: 'kernel-must-not-depend-on-modules',
      severity: 'error',
      comment: 'kernel is the bottom of the stack; it may never import a business module.',
      from: { path: '^libs/kernel/' },
      to: { path: '^libs/(modules|platform)/' },
    },
    {
      name: 'shared-must-not-depend-on-anything',
      severity: 'error',
      comment: 'shared is a leaf library with zero internal dependencies.',
      from: { path: '^libs/shared/' },
      to: { path: '^libs/(kernel|platform|modules)/' },
    },
    {
      name: 'platform-must-not-depend-on-modules',
      severity: 'error',
      comment: 'platform services (audit, messaging, files) may not import business modules.',
      from: { path: '^libs/platform/' },
      to: { path: '^libs/modules/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: '(node_modules|dist|\\.spec\\.ts$|\\.int\\.spec\\.ts$)' },
  },
};
