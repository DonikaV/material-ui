import {
  UnpluginFactoryOutput,
  WebpackPluginInstance,
  createUnplugin,
  UnpluginOptions,
} from 'unplugin';
import { transformAsync } from '@babel/core';
import type { PluginOptions as LinariaPluginOptions, Preprocessor } from '@linaria/babel-preset';
import { TransformCacheCollection, transform } from '@linaria/babel-preset';
import { createPerfMeter, asyncResolveFallback, slugify } from '@linaria/utils';
import {
  generateCss,
  preprocessor as basePreprocessor,
  generateThemeTokens,
} from '@mui/zero-runtime/utils';

type NextMeta = {
  type: 'next';
  dev: boolean;
  isServer: boolean;
  outputCss: boolean;
  placeholderCssFile: string;
};

type ViteMeta = {
  type: 'vite';
};

type WebpackMeta = {
  type: 'webpack';
};

type Meta = NextMeta | ViteMeta | WebpackMeta;

export type PluginOptions<Theme = unknown> = {
  theme: Theme;
  cssVariablesPrefix?: string;
  injectDefaultThemeInRoot?: boolean;
  transformLibraries?: string[];
  preprocessor?: Preprocessor;
  debug?: boolean;
  sourceMap?: boolean;
  meta?: Meta;
  asyncResolve?: (what: string) => string | null;
  transformSx?: boolean;
} & Partial<LinariaPluginOptions>;

const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

function hasCorectExtension(fileName: string) {
  return extensions.some((ext) => fileName.endsWith(ext));
}

const VIRTUAL_CSS_FILE = `\0zero-runtime-styles.css`;
const VIRTUAL_THEME_FILE = `\0zero-runtime-theme.js`;

function isZeroRuntimeThemeFile(fileName: string) {
  return fileName === VIRTUAL_CSS_FILE || fileName === VIRTUAL_THEME_FILE;
}

function isZeroRuntimeProcessableFile(fileName: string, transformLibraries: string[]) {
  const isNodeModule = fileName.includes('node_modules');
  const isTransformableFile =
    isNodeModule && transformLibraries.some((libName) => fileName.includes(libName));
  return (
    hasCorectExtension(fileName) &&
    (isTransformableFile || !isNodeModule) &&
    !fileName.includes('runtime/build')
  );
}

/**
 * Next.js initializes the plugin multiple times. So all the calls
 * have to share the same Maps.
 */
const globalCssFileLookup = new Map<string, string>();
const globalCssLookup = new Map<string, string>();

const pluginName = 'ZeroWebpackPlugin';

function innerNoop() {
  return null;
}

function outerNoop() {
  return innerNoop;
}

export const plugin = createUnplugin<PluginOptions, true>((options) => {
  const {
    theme,
    meta,
    cssVariablesPrefix = 'mui',
    injectDefaultThemeInRoot = true,
    transformLibraries = [],
    preprocessor = basePreprocessor,
    asyncResolve: asyncResolveOpt,
    debug = false,
    sourceMap = false,
    transformSx = true,
    overrideContext,
    tagResolver,
    ...rest
  } = options;
  const themeArgs = { theme };
  const isExtendTheme = !!(theme && typeof theme === 'object' && 'vars' in theme && theme.vars);
  const varPrefix: string =
    isExtendTheme && 'cssVarPrefix' in theme
      ? (theme.cssVarPrefix as string) ?? cssVariablesPrefix
      : cssVariablesPrefix;
  const cache = new TransformCacheCollection();
  const { emitter, onDone } = createPerfMeter(debug);
  const cssLookup = meta?.type === 'next' ? globalCssLookup : new Map<string, string>();
  const cssFileLookup = meta?.type === 'next' ? globalCssFileLookup : new Map<string, string>();
  const isNext = meta?.type === 'next';
  const outputCss = isNext && meta.outputCss;

  const themeTokenCss = generateCss(
    { themeArgs, cssVariablesPrefix: varPrefix },
    {
      injectInRoot: injectDefaultThemeInRoot,
    },
  );

  const babelTransformPlugin: UnpluginOptions = {
    name: 'zero-plugin-transform-babel',
    enforce: 'post',
    transformInclude(id) {
      return isZeroRuntimeProcessableFile(id, transformLibraries);
    },
    async transform(code, id) {
      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        plugins: [[`${process.env.RUNTIME_PACKAGE_NAME}/exports/sx-plugin`]],
      });
      if (!result) {
        return null;
      }
      return {
        code: result.code ?? code,
        map: result.map,
      };
    },
  };
  const linariaTransformPlugin: UnpluginOptions = {
    name: 'zero-plugin-transform-linaria',
    enforce: 'post',
    buildEnd() {
      onDone(process.cwd());
    },
    transformInclude(id) {
      return isZeroRuntimeProcessableFile(id, transformLibraries);
    },
    async transform(code, id) {
      const asyncResolve: typeof asyncResolveFallback = async (what, importer, stack) => {
        const result = asyncResolveOpt?.(what);
        if (typeof result === 'string') {
          return result;
        }
        return asyncResolveFallback(what, importer, stack);
      };
      const transformServices = {
        options: {
          filename: id,
          root: process.cwd(),
          preprocessor,
          pluginOptions: {
            ...rest,
            themeArgs: {
              theme,
            },
            cssVariablesPrefix: varPrefix,
            overrideContext(context: Record<string, unknown>, filename: string) {
              if (overrideContext) {
                return overrideContext(context, filename);
              }
              if (!context.$RefreshSig$) {
                context.$RefreshSig$ = outerNoop;
              }
              return context;
            },
            tagResolver(source: string, tag: string) {
              const tagResult = tagResolver?.(source, tag);
              if (tagResult) {
                return tagResult;
              }
              if (source.endsWith('/zero-styled')) {
                return `${process.env.RUNTIME_PACKAGE_NAME}/exports/${tag}`;
              }
              return null;
            },
            babelOptions: {
              ...rest.babelOptions,
              plugins: [
                ['babel-plugin-transform-react-remove-prop-types', { mode: 'remove' }],
                ...(rest.babelOptions?.plugins ?? []),
              ],
            },
          },
        },
        cache,
        eventEmitter: emitter,
      };

      try {
        const result = await transform(transformServices, code, asyncResolve);

        if (!result.cssText) {
          return null;
        }

        let { cssText } = result;
        if (isNext && !outputCss) {
          return {
            code: result.code,
            map: result.sourceMap,
          };
        }
        const slug = slugify(cssText);
        const cssFilename = `${slug}.zero.css`;

        if (sourceMap && result.cssSourceMapText) {
          const map = Buffer.from(result.cssSourceMapText).toString('base64');
          cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
        }

        // Virtual modules do not work consistently in Next.js (the build is done at least
        // thrice) resulting in error in subsequent builds. So we use a placeholder CSS
        // file with the actual CSS content as part of the query params.
        if (isNext) {
          const data = `${meta.placeholderCssFile}?${encodeURIComponent(
            JSON.stringify({
              filename: cssFilename,
              source: cssText,
            }),
          )}`;
          return {
            code: `import ${JSON.stringify(data)};\n${result.code}`,
            map: result.sourceMap,
          };
        }
        const cssId = `./${cssFilename}`;
        cssFileLookup.set(cssId, cssFilename);
        cssLookup.set(cssFilename, cssText);
        return {
          code: `import ${JSON.stringify(`./${cssFilename}`)};\n${result.code}`,
          map: result.sourceMap,
        };
      } catch (e) {
        const error = new Error((e as Error).message);
        error.stack = (e as Error).stack;
        throw error;
      }
    },
  };

  const plugins: Array<UnpluginOptions> = [
    {
      name: 'zero-plugin-theme-tokens',
      enforce: 'pre',
      webpack(compiler) {
        compiler.hooks.normalModuleFactory.tap(pluginName, (nmf) => {
          nmf.hooks.createModule.tap(
            pluginName,
            // @ts-expect-error CreateData is typed as 'object'...
            (createData: { matchResource?: string; settings: { sideEffects?: boolean } }) => {
              if (createData.matchResource && createData.matchResource.endsWith('.zero.css')) {
                createData.settings.sideEffects = true;
              }
            },
          );
        });
      },
      ...(isNext
        ? {
            transformInclude(id) {
              return (
                // this file should exist in the package
                id.endsWith('@mui/zero-runtime/styles.css') ||
                id.endsWith('/zero-runtime/styles.css') ||
                id.endsWith('@mui/zero-runtime/theme') ||
                id.endsWith('/zero-runtime/theme.js')
              );
            },
            transform(_code, id) {
              if (id.endsWith('styles.css')) {
                return themeTokenCss;
              }
              if (id.endsWith('theme.js')) {
                const tokens = generateThemeTokens(theme, varPrefix);
                return `export default ${JSON.stringify(tokens)};`;
              }
              return null;
            },
          }
        : {
            resolveId(source: string) {
              if (source === '@mui/zero-runtime/styles.css') {
                return VIRTUAL_CSS_FILE;
              }
              if (source === '@mui/zero-runtime/theme') {
                return VIRTUAL_THEME_FILE;
              }
              return null;
            },
            loadInclude(id) {
              return isZeroRuntimeThemeFile(id);
            },
            load(id) {
              if (id === VIRTUAL_CSS_FILE) {
                return themeTokenCss;
              }
              if (id === VIRTUAL_THEME_FILE) {
                const tokens = generateThemeTokens(theme, varPrefix);
                return `export default ${JSON.stringify(tokens)};`;
              }
              return null;
            },
          }),
    },
  ];

  if (transformSx) {
    plugins.push(babelTransformPlugin);
  }
  plugins.push(linariaTransformPlugin);

  // This is already handled separately for Next.js using `placeholderCssFile`
  if (!isNext) {
    plugins.push({
      name: 'zero-plugin-load-output-css',
      enforce: 'pre',
      resolveId(source: string) {
        return cssFileLookup.get(source);
      },
      loadInclude(id) {
        return id.endsWith('.zero.css');
      },
      load(id) {
        return cssLookup.get(id) ?? '';
      },
    });
  }
  return plugins;
});

export const webpack = plugin.webpack as unknown as UnpluginFactoryOutput<
  PluginOptions,
  WebpackPluginInstance
>;
