/**
 * dsh-conversation-cost — Client half (zero-build module-loader bundle).
 *
 * Two registrations:
 *   - `conversation.composer.dock` / id `cost`: the compact ¥ reading beside the
 *     shipped composer statistics.
 *   - `conversation.input.dock` / id `cost-detail`: the expandable breakdown card
 *     above the composer, opened by the reading.
 *
 * Data comes from the Host half's read-only route; nothing here computes prices.
 */

(function () {
  'use strict';

  window.__ModuleLoader__.load({
    id: 'dsh-conversation-cost',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;

      var API_BASE = '/api/dsh-conversation-cost';
      var POLL_MS = 5000;
      var CSS_ID = 'dsh-conversation-cost-styles';
      var NS = 'conversation-cost';

      // ---- shared render bus (locale switches + panel toggles) ----
      var bus = { version: 0, listeners: new Set() };
      function bump() {
        bus.version += 1;
        bus.listeners.forEach(function (fn) {
          try {
            fn();
          } catch (error) {
            /* a broken listener must not stop the others */
          }
        });
      }
      function useBus() {
        var state = useState(0);
        useEffect(function () {
          var fn = function () {
            state[1](bus.version);
          };
          bus.listeners.add(fn);
          return function () {
            bus.listeners.delete(fn);
          };
        }, []);
        return state[0];
      }

      // ---- translations (bound to the locale service in apply) ----
      var translate = function (key) {
        return key;
      };
      function t(key) {
        var text = translate(key);
        if (text === undefined || text === null) return key;
        if (arguments.length === 1) return text;
        var rendered = String(text);
        for (var index = 1; index < arguments.length; index += 1) {
          rendered = rendered.replace('{' + (index - 1) + '}', String(arguments[index]));
        }
        return rendered;
      }

      // ---- panel state (one open detail card at a time) ----
      var openSessionId = null;
      function togglePanel(sessionId) {
        openSessionId = openSessionId === sessionId ? null : sessionId;
        bump();
      }
      function closePanel() {
        if (openSessionId === null) return;
        openSessionId = null;
        bump();
      }

      // ---- usage store: one poller per looked-at session ----
      var IDLE = { phase: 'idle', data: undefined, error: undefined };
      var snapshots = Object.create(null);
      var subscribers = Object.create(null);
      var timers = Object.create(null);

      function snapshotOf(sessionId) {
        if (!sessionId) return IDLE;
        return snapshots[sessionId] || IDLE;
      }

      function publish(sessionId, next) {
        snapshots[sessionId] = next;
        var set = subscribers[sessionId];
        if (!set) return;
        set.forEach(function (fn) {
          try {
            fn();
          } catch (error) {
            /* ignore listener failures */
          }
        });
      }

      function refresh(sessionId) {
        if (!sessionId) return;
        var current = snapshotOf(sessionId);
        if (current.phase !== 'ready' && current.phase !== 'error') {
          publish(sessionId, { phase: 'loading', data: current.data, error: undefined });
        }
        fetch(API_BASE + '/session?sessionId=' + encodeURIComponent(sessionId), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin'
        })
          .then(function (response) {
            return response.json().then(function (body) {
              return { status: response.status, ok: response.ok, body: body };
            });
          })
          .then(function (result) {
            var body = result.body;
            if (body === undefined || body === null || body.ok !== true) {
              var reason = body !== undefined && body !== null && body.reason ? body.reason : 'HTTP ' + result.status;
              publish(sessionId, { phase: 'error', data: snapshots[sessionId] && snapshots[sessionId].data, error: reason });
              return;
            }
            publish(sessionId, { phase: 'ready', data: body, error: undefined });
          })
          .catch(function (error) {
            publish(sessionId, {
              phase: 'error',
              data: snapshots[sessionId] && snapshots[sessionId].data,
              error: error !== undefined && error !== null && error.message ? error.message : String(error)
            });
          });
      }

      function subscribe(sessionId, listener) {
        if (!sessionId) return function () {};
        var set = subscribers[sessionId];
        if (!set) {
          set = new Set();
          subscribers[sessionId] = set;
        }
        set.add(listener);
        if (timers[sessionId] === undefined) {
          refresh(sessionId);
          timers[sessionId] = window.setInterval(function () {
            if (document.visibilityState === 'hidden') return;
            refresh(sessionId);
          }, POLL_MS);
        } else if (snapshots[sessionId] === undefined) {
          refresh(sessionId);
        }
        return function () {
          var current = subscribers[sessionId];
          if (current) {
            current.delete(listener);
            if (current.size === 0) {
              delete subscribers[sessionId];
              if (timers[sessionId] !== undefined) {
                window.clearInterval(timers[sessionId]);
                delete timers[sessionId];
              }
            }
          }
        };
      }

      function useUsage(sessionId) {
        var state = useState(function () {
          return snapshotOf(sessionId);
        });
        useEffect(
          function () {
            state[1](snapshotOf(sessionId));
            return subscribe(sessionId, function () {
              state[1](snapshotOf(sessionId));
            });
          },
          [sessionId]
        );
        return state[0];
      }

      // ---- formatting ----
      function formatYuan(value) {
        if (typeof value !== 'number' || !isFinite(value)) return '—';
        if (value === 0) return '0.00';
        if (value < 0.01) return value.toFixed(4);
        if (value < 1) return value.toFixed(3);
        return value.toFixed(2);
      }

      function formatCount(value) {
        if (typeof value !== 'number' || !isFinite(value)) return '—';
        if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(value);
      }

      function formatClock(value) {
        if (typeof value !== 'number' || !isFinite(value)) return '—';
        try {
          return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (error) {
          return '—';
        }
      }

      // ---- styles ----
      var CSS_TEXT = [
        '.dcc-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px;',
        '  border: 1px solid transparent; border-radius: 6px; background: transparent; cursor: pointer;',
        '  font-family: inherit; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-secondary, #61666b);',
        '  font-variant-numeric: tabular-nums; white-space: nowrap; }',
        '.dcc-chip:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #0f1115); }',
        '.dcc-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: 1px; }',
        '.dcc-chip[data-open="true"] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.1)); color: var(--dsw-alias-label-primary, #0f1115); }',
        '.dcc-chip-sign { font-size: 11px; opacity: 0.75; }',
        '.dcc-card { box-sizing: border-box; width: 100%; margin: 0 0 6px 0; padding: 10px 12px; border-radius: 12px;',
        '  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2)); background: var(--dsw-alias-bg-layer-1, #fff);',
        '  color: var(--dsw-alias-label-primary, #0f1115); font-size: 12px; line-height: 1.5; }',
        '.dcc-card * { box-sizing: border-box; }',
        '.dcc-head { display: flex; align-items: center; gap: 8px; }',
        '.dcc-title { font-weight: 600; font-size: 12px; }',
        '.dcc-total { margin-left: auto; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }',
        '.dcc-close { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;',
        '  padding: 0; border: 0; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; opacity: 0.6; }',
        '.dcc-close:hover { opacity: 1; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12)); }',
        '.dcc-meta { margin-top: 2px; color: var(--dsw-alias-label-secondary, #61666b); font-size: 11px; }',
        '.dcc-rows { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }',
        '.dcc-row { display: grid; grid-template-columns: minmax(96px, 1fr) minmax(0, 1.6fr) auto; gap: 8px; align-items: baseline;',
        '  padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16)); }',
        '.dcc-row:first-child { padding-top: 0; border-top: 0; }',
        '.dcc-model { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dcc-tokens { color: var(--dsw-alias-label-secondary, #61666b); font-size: 11px; font-variant-numeric: tabular-nums; }',
        '.dcc-cost { font-variant-numeric: tabular-nums; white-space: nowrap; }',
        '.dcc-empty { margin-top: 6px; color: var(--dsw-alias-label-secondary, #61666b); }',
        '.dcc-foot { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.16));',
        '  display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, #61666b); font-size: 11px; }',
        '.dcc-foot-text { min-width: 0; flex: 1; }',
        '.dcc-refresh { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; padding: 2px 4px; border-radius: 5px; }',
        '.dcc-refresh:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, #0f1115); }',
        '.dcc-warn { color: var(--dsw-alias-state-warn-primary, #b26a00); }',
        '.dcc-turn { display: inline-flex; align-items: center; gap: 6px; margin: 2px 0 4px 0; padding: 0;',
        '  font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #61666b); font-variant-numeric: tabular-nums; }',
        '.dcc-turn-label { opacity: 0.85; }',
        '.dcc-turn-value { color: var(--dsw-alias-label-primary, #0f1115); font-weight: 500; }',
        '.dcc-turn-meta { opacity: 0.75; }',
      ].join('\n');

      function injectStyles() {
        var existing = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
        if (existing) existing.remove();
        var tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', CSS_ID);
        tag.textContent = CSS_TEXT;
        document.head.appendChild(tag);
        return function () {
          var current = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
          if (current) current.remove();
        };
      }

      // ---- components ----
      /**
       * Read a turn number out of the owner's Turn location, if it exposes one.
       * @param turn - the TurnLocation owner value
       * @returns the turn number, or undefined
       */
      function turnNumberOf(turn) {
        if (typeof turn === 'number' && isFinite(turn)) return turn;
        if (turn === null || typeof turn !== 'object') return undefined;
        var keys = ['turn', 'index', 'number', 'ordinal', 'value', 'id'];
        for (var index = 0; index < keys.length; index += 1) {
          var candidate = turn[keys[index]];
          if (typeof candidate === 'number' && isFinite(candidate)) return candidate;
        }
        return undefined;
      }

      /**
       * Resolve the per-turn bucket that owns one completed Turn.
       * @param data - the Host payload
       * @param seq - the Turn's closing sequence
       * @param turnProp - the Turn location owner value
       * @returns the matching turn bucket, when the payload covers it
       */
      function turnEntryOf(data, seq, turnProp) {
        if (data === undefined || data === null || !Array.isArray(data.turns) || data.turns.length === 0) return undefined;
        var list = data.turns;
        var wanted = turnNumberOf(turnProp);
        if (wanted !== undefined) {
          for (var at = 0; at < list.length; at += 1) {
            if (list[at].turn === wanted) return list[at];
          }
        }
        if (typeof seq !== 'number') return undefined;
        var preceding;
        for (var index = 0; index < list.length; index += 1) {
          var entry = list[index];
          if (typeof entry.startSeq !== 'number' || typeof entry.endSeq !== 'number') continue;
          if (seq >= entry.startSeq && seq <= entry.endSeq) return entry;
          if (entry.endSeq <= seq && (preceding === undefined || entry.endSeq > preceding.endSeq)) preceding = entry;
        }
        // A closing sequence may point just past the Turn's last logged event.
        if (preceding !== undefined && (seq - preceding.endSeq <= 1 || preceding === list[list.length - 1])) {
          return preceding;
        }
        return undefined;
      }

      function TurnCost(props) {
        useBus();
        var sessionId = props !== undefined && props !== null ? props.sessionId : undefined;
        var seq = props !== undefined && props !== null ? props.seq : undefined;
        var turnProp = props !== undefined && props !== null ? props.turn : undefined;
        var usage = useUsage(sessionId);
        var entry = usage.phase === 'ready' ? turnEntryOf(usage.data, seq, turnProp) : undefined;
        if (entry === undefined || entry === null) return null;

        var input = entry.cacheHitTokens + entry.cacheMissTokens;
        var titleText =
          t('turnTip') +
          '\n' +
          t('turnTokens', formatCount(input), formatCount(entry.cacheHitTokens), formatCount(entry.outputTokens)) +
          '\n' +
          t('turnRequests', entry.requests);

        return h(
          'div',
          { className: 'dcc-turn', 'data-turn-cost': String(entry.turn), title: titleText },
          h('span', { className: 'dcc-turn-label' }, t('turnLabel')),
          h('span', { className: 'dcc-turn-value' }, '¥' + formatYuan(entry.cost)),
          h('span', { className: 'dcc-turn-meta' }, t('turnRequests', entry.requests))
        );
      }

      function CostChip(props) {
        useBus();
        var sessionId = props !== undefined && props !== null ? props.sessionId : undefined;
        var usage = useUsage(sessionId);
        if (!sessionId || sessionId === '') return null;

        var data = usage.data;
        var amount;
        if (data !== undefined && data !== null && typeof data.totalCost === 'number') {
          amount = formatYuan(data.totalCost);
        } else if (usage.phase === 'error') {
          amount = '—';
        } else {
          amount = '…';
        }

        var titleText = t('chipTip');
        if (data !== undefined && data !== null && typeof data.totalCost === 'number') {
          titleText =
            t('chipTitle') +
            '\n' +
            t('chipTotal', '¥' + formatYuan(data.totalCost)) +
            '\n' +
            t('chipRequests', data.requests) +
            '\n' +
            t('chipTokens', formatCount(data.inputTokens), formatCount(data.outputTokens));
        }

        return h(
          'button',
          {
            type: 'button',
            className: 'dcc-chip',
            'data-composer-stat': 'cost',
            'data-open': openSessionId === sessionId ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'aria-expanded': openSessionId === sessionId,
            title: titleText,
            onClick: function () {
              togglePanel(sessionId);
            }
          },
          h('span', { className: 'dcc-chip-sign', 'aria-hidden': 'true' }, '¥'),
          h('span', null, amount),
          h(
            'span',
            {
              style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }
            },
            t('chipLabel')
          )
        );
      }

      function ModelRow(props) {
        var model = props.model;
        var label = model.pricingLabel ? model.pricingLabel : model.model;
        // An estimate shows both the estimate marker and WHY it was estimated.
        var reason =
          model.match === 'catalog'
            ? t('matchCatalog', model.model)
            : model.match === 'heuristic'
              ? t('matchHeuristic', model.model)
              : model.match === 'retired'
                ? t('matchRetired', model.model)
                : t('matchUnknown', model.model);
        var tokens =
          t('rowTokens', formatCount(model.cacheHitTokens)) +
          ' · ' +
          t('rowMiss', formatCount(model.cacheMissTokens)) +
          ' · ' +
          t('rowOut', formatCount(model.outputTokens));
        return h(
          'div',
          { className: 'dcc-row' },
          h(
            'span',
            {
              className: 'dcc-model',
              title: model.model + '\n' + (model.fallback ? reason + '\n' + t('fallbackRate') : t('exactRate'))
            },
            label,
            model.fallback ? h('span', { className: 'dcc-warn' }, ' ≈') : null
          ),
          h('span', { className: 'dcc-tokens' }, tokens),
          h('span', { className: 'dcc-cost' }, '¥' + formatYuan(model.cost))
        );
      }

      function CostPanel(props) {
        useBus();
        var sessionId = props !== undefined && props !== null ? props.sessionId : undefined;
        var usage = useUsage(sessionId);
        var open = sessionId !== undefined && sessionId !== null && openSessionId === sessionId;

        useEffect(
          function () {
            if (!open) return undefined;
            var onKeyDown = function (event) {
              if (event.key === 'Escape') closePanel();
            };
            document.addEventListener('keydown', onKeyDown);
            return function () {
              document.removeEventListener('keydown', onKeyDown);
            };
          },
          [open]
        );

        if (!open) return null;

        var data = usage.phase === 'ready' ? usage.data : undefined;
        var rows = [];
        if (data !== undefined && data !== null && Array.isArray(data.models)) {
          for (var index = 0; index < data.models.length; index += 1) {
            rows.push(h(ModelRow, { key: data.models[index].model, model: data.models[index] }));
          }
        }

        var meta = [];
        if (data !== undefined && data !== null) {
          meta.push(t('metaRequests', data.requests));
          if (data.requests > 0) {
            meta.push(t('metaPeak', data.peakRequests, data.offPeakRequests));
          }
        }

        return h(
          'div',
          { className: 'dcc-card', role: 'dialog', 'aria-label': t('panelTitle') },
          h(
            'div',
            { className: 'dcc-head' },
            h('span', { className: 'dcc-title' }, t('panelTitle')),
            h(
              'span',
              { className: 'dcc-total' },
              data !== undefined && data !== null ? '¥' + formatYuan(data.totalCost) : usage.phase === 'error' ? '¥—' : '¥…'
            ),
            h(
              'button',
              { type: 'button', className: 'dcc-close', title: t('close'), onClick: closePanel },
              h(
                'svg',
                {
                  width: 12,
                  height: 12,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 2,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': 'true'
                },
                h('path', { d: 'M18 6 6 18' }),
                h('path', { d: 'm6 6 12 12' })
              )
            )
          ),
          meta.length > 0 ? h('div', { className: 'dcc-meta' }, meta.join(' · ')) : null,
          rows.length > 0
            ? h('div', { className: 'dcc-rows' }, rows)
            : h(
                'div',
                { className: 'dcc-empty' },
                usage.phase === 'error' ? t('errorLoad', usage.error) : t('emptyUsage')
              ),
          h(
            'div',
            { className: 'dcc-foot' },
            h('span', { className: 'dcc-foot-text' }, t('footNote')),
            h(
              'span',
              null,
              data !== undefined && data !== null ? formatClock(data.updatedAt) : ''
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dcc-refresh',
                title: t('refresh'),
                onClick: function () {
                  refresh(sessionId);
                }
              },
              t('refresh')
            )
          )
        );
      }

      // ---- locales ----
      var zh = {
        chipLabel: '对话费用',
        chipTip: '点击查看本次对话的费用明细',
        chipTitle: '本次对话费用（估算）',
        chipTotal: '合计 {0}',
        chipRequests: '{0} 次模型请求',
        chipTokens: '输入 {0} · 输出 {1} tokens',
        panelTitle: '对话费用',
        close: '关闭',
        metaRequests: '{0} 次请求',
        metaPeak: '高峰 {0} 次 / 空闲 {1} 次',
        rowTokens: '缓存命中 {0}',
        rowMiss: '未命中 {0}',
        rowOut: '输出 {0}',
        fallbackRate: '未在价目表中，按 Flash 单价估算',
        matchCatalog: '{0} 是当前运行时提供的模型，但价目表里没有它的单价。',
        matchHeuristic: '{0} 无法精确匹配，按名称推断的单价估算。',
        matchRetired: '{0} 是已下线的模型名，请求由 Flash 提供服务。',
        matchUnknown: '{0} 未在价目表中，也不是当前运行时提供的模型。',
        exactRate: '按官方价目表精确计价。',
        emptyUsage: '本次对话还没有模型上报的 token 用量。',
        errorLoad: '暂时读不到费用（{0}）。会话需要处于打开状态。',
        footNote: '按 DeepSeek 官方人民币价目表（元/百万 tokens）计费，高峰时段为北京时间工作日 9:00-12:00、14:00-18:00。',
        refresh: '刷新',
        turnLabel: '本轮费用',
        turnTip: '这一轮的模型费用（按 DeepSeek 官方人民币价目表）',
        turnTokens: '输入 {0}（缓存命中 {1}）· 输出 {2} tokens',
        turnRequests: '{0} 次请求',
      };
      var en = {
        chipLabel: 'Conversation cost',
        chipTip: 'Open the cost breakdown for this conversation',
        chipTitle: 'Conversation cost (estimated)',
        chipTotal: 'Total {0}',
        chipRequests: '{0} model requests',
        chipTokens: 'Input {0} · output {1} tokens',
        panelTitle: 'Conversation cost',
        close: 'Close',
        metaRequests: '{0} requests',
        metaPeak: 'Peak {0} / off-peak {1}',
        rowTokens: 'cache hit {0}',
        rowMiss: 'miss {0}',
        rowOut: 'out {0}',
        fallbackRate: 'Not in the price table; estimated at the Flash rate',
        matchCatalog: '{0} is served by this runtime, but the price table has no row for it.',
        matchHeuristic: '{0} could not be matched exactly; the rate is inferred from its name.',
        matchRetired: '{0} is a retired model id; requests are served by Flash.',
        matchUnknown: '{0} is neither in the price table nor served by this runtime.',
        exactRate: 'Priced exactly from the official table.',
        emptyUsage: 'No provider-reported token usage in this conversation yet.',
        errorLoad: 'Cost is not readable right now ({0}). The session must be open.',
        footNote: 'Billed with the official DeepSeek RMB table (CNY per million tokens); peak hours are Beijing-time weekdays 09:00-12:00 and 14:00-18:00.',
        refresh: 'Refresh',
        turnLabel: 'Turn cost',
        turnTip: 'Model cost of this turn, priced with the official DeepSeek RMB table',
        turnTokens: 'input {0} (cache hit {1}) · output {2} tokens',
        turnRequests: '{0} requests',
      };

      // ---- apply ----
      function apply(ctx) {
        var disposeStyles = injectStyles();
        ctx.effect(function () {
          return disposeStyles;
        }, 'dsh-conversation-cost: styles');

        if (ctx.locale) {
          var unregister = ctx.locale.register(NS, { zh: zh, 'zh-CN': zh, en: en, 'en-US': en });
          translate = ctx.locale.bind(NS);
          ctx.effect(function () {
            var off = ctx.locale.subscribe(bump);
            return function () {
              if (off) off();
              if (unregister) unregister();
            };
          }, 'dsh-conversation-cost: locale');
        }

        if (!ctx.slots) return;

        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'cost',
              order: 2,
              label: function () {
                return t('panelTitle');
              },
              locale: NS
            },
            CostChip
          );
        });

        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'cost-detail',
              order: 15,
              label: function () {
                return t('panelTitle');
              },
              locale: NS
            },
            CostPanel
          );
        });

        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'cost',
              order: 30,
              label: function () {
                return t('turnLabel');
              },
              locale: NS
            },
            TurnCost
          );
        });
      }

      exports.apply = apply;
      exports.inject = ['slots', 'locale'];
      exports.default = { apply: apply, inject: ['slots', 'locale'] };
      // Exposed for scripts/check.mjs only; not part of the plugin contract.
      exports.__internals = { turnEntryOf: turnEntryOf, formatYuan: formatYuan, formatCount: formatCount };

      return module.exports;
    }
  });
})();
