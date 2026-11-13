/**
 * dsh-prompt-booster —— 浏览器半边（Client 插件）。
 *
 * 在聊天输入框工具栏右侧（slot conversation.input.right，发送按钮之前）注册一个
 * 「增强」按钮：
 *   - 取当前草稿 → POST /prompt-booster/enhance → 模型改写 → 回填输入框；
 *   - 回填后出现「撤销」，把草稿恢复成增强前的文本；
 *   - 增强失败时按钮变成错误提示（悬停看原因），不破坏草稿。
 *
 * 这是纯 JS 的 client bundle：不依赖构建工具，直接以
 * window.__ModuleLoader__.load({id, factory}) 形式注册（id 必须等于包名）。
 * React 从浏览器模块表 require 获得；样式只用 --dsw-alias-* 主题 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-booster',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-booster'
    const ROUTE = '/prompt-booster'
    const SLOT = 'conversation.input.right'

    /** 简体中文是 key-set 的基准；en 必须覆盖同一组 key。 */
    const ZH = {
      label: '增强',
      aria: '增强提示词',
      title: '增强提示词：用模型把草稿改写成更清楚、可执行的提示词（可撤销）',
      titleWithContext: '增强提示词：结合当前项目上下文重写草稿（可撤销）',
      busyTitle: '正在增强提示词…',
      busyLabel: '增强中…',
      emptyTitle: '先写点内容，再点「增强」',
      undoLabel: '撤销',
      undoTitle: '撤销：返回最初的原句',
      undoAria: '撤销所有增强，返回最初的原句',
      stepBackLabel: '退改',
      stepBackTitle: '退改：返回上一版提示词',
      stepBackAria: '返回上一版提示词',
      failedLabel: '失败',
      failedTitle: '增强失败',
      requestFailed: '增强失败',
    }
    const EN = {
      label: 'Enhance',
      aria: 'Enhance prompt',
      title: 'Enhance prompt: rewrite the draft into a clearer, executable prompt (undoable)',
      titleWithContext: 'Enhance prompt: rewrite the draft using the current project context (undoable)',
      busyTitle: 'Enhancing prompt…',
      busyLabel: 'Enhancing…',
      emptyTitle: 'Write something first',
      undoLabel: 'Undo all',
      undoTitle: 'Undo all: restore the original draft',
      undoAria: 'Undo all enhancements',
      stepBackLabel: 'Back',
      stepBackTitle: 'Back: restore the previous enhanced version',
      stepBackAria: 'Restore previous enhanced version',
      failedLabel: 'Failed',
      failedTitle: 'Enhancement failed',
      requestFailed: 'Enhancement failed',
    }

    const CSS = [
      '.pb-wrap{display:inline-flex;align-items:center;gap:6px;position:relative;min-width:0}',
      '.pb-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;',
      'transition:background .12s,color .12s,border-color .12s;white-space:nowrap;font-family:inherit}',
      '.pb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
      '.pb-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.pb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.pb-btn:disabled{cursor:default;opacity:.45}',
      '.pb-btn svg{flex:none;display:block}',
      '.pb-busy svg{animation:pb-spin 1s linear infinite}',
      '.pb-undo{display:inline-flex;align-items:center;height:24px;padding:0 6px;',
      'border:1px solid transparent;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer;font-family:inherit}',
      '.pb-undo:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.pb-undo:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.pb-err{color:var(--dsw-alias-label-error);font-size:11px;line-height:1;white-space:nowrap;cursor:help}',
      '@keyframes pb-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.pb-busy svg{animation:none}}',
    ].join('')

    function isZh() {
      try {
        const lang = (document.documentElement.getAttribute('lang') || navigator.language || 'zh').toLowerCase()
        return lang.indexOf('zh') === 0
      } catch (e) {
        return true
      }
    }

    function resolveText(t, key) {
      if (typeof t === 'function') {
        try {
          const value = t(key)
          if (value != null && value !== key) return String(value)
        } catch (e) {
          /* 回退到内置字典 */
        }
      }
      const dict = isZh() ? ZH : EN
      return dict[key] != null ? dict[key] : key
    }

    function transportBase() {
      try {
        const transport = globalThis.__DSH_TRANSPORT__
        return transport && typeof transport.streamBaseUrl === 'string' ? transport.streamBaseUrl : ''
      } catch (e) {
        return ''
      }
    }

    /** 回退地址只允许回环 http(s) 或桌面壳自定义协议，防止把草稿发到外部主机。 */
    function loopbackHttpBase(base) {
      if (!base) return ''
      try {
        const url = new URL(base)
        if (url.protocol === 'dsh-app:') return url.href
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
        const loopback = host === 'localhost' || host === '::1' || host.indexOf('127.') === 0
        return loopback ? url.href : ''
      } catch (e) {
        return ''
      }
    }

    function absoluteUrl(suffix) {
      const base = loopbackHttpBase(transportBase())
      if (!base) return ''
      try {
        return new URL(ROUTE + suffix, base).toString()
      } catch (e) {
        return ''
      }
    }

    function pageToken() {
      try {
        const token = globalThis.__PROMPT_BOOSTER_TOKEN__
        return typeof token === 'string' ? token : ''
      } catch (e) {
        return ''
      }
    }

    /** 从当前页面 Chat 视图取最近 2 轮 prompt/response 预览（不读会话历史）。 */
    function recentMessagesFrom(chatSnapshot) {
      try {
        const items =
          chatSnapshot && chatSnapshot.navigation && typeof chatSnapshot.navigation.items === 'function'
            ? chatSnapshot.navigation.items()
            : []
        const messages = []
        for (const item of items.slice(-2)) {
          if (!item) continue
          const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
          const response = typeof item.response === 'string' ? item.response.trim() : ''
          if (prompt) messages.push({ role: 'user', text: prompt })
          if (response) messages.push({ role: 'assistant', text: response })
        }
        return { messages: messages.slice(-4), turns: Math.min(items.length, 2) }
      } catch (e) {
        return { messages: [], turns: 0 }
      }
    }

    function currentLocale() {
      try {
        return String(document.documentElement.getAttribute('lang') || navigator.language || 'zh')
      } catch (e) {
        return 'zh'
      }
    }

    async function postJson(url, payload, timeoutMs, outerSignal) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs || 120000)
      const onAbort = () => controller.abort()
      if (outerSignal) {
        if (outerSignal.aborted) controller.abort()
        else outerSignal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        const headers = { 'content-type': 'application/json' }
        const token = pageToken()
        if (token) headers['x-pb-token'] = token
        const response = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
          credentials: 'same-origin',
        })
        let data = null
        try {
          data = await response.json()
        } catch (e) {
          /* 非 JSON 响应按 HTTP 错误处理 */
        }
        if (!response.ok) {
          const error = new Error((data && (data.error || data.message)) || 'HTTP ' + response.status)
          error.httpStatus = response.status
          error.reason = data && data.reason
          throw error
        }
        return data || {}
      } finally {
        clearTimeout(timer)
        if (outerSignal) outerSignal.removeEventListener('abort', onAbort)
      }
    }

    /**
     * 同源优先；若桌面壳是 file:// 页面，则回退到经过校验的本机 streamBaseUrl。
     * baseText：首次增强前的原句，用于多次增强时的连续纠正。
     */
    async function requestEnhance(text, project, sessionId, recentMessages, signal, baseText) {
      const payload = { text: text, locale: currentLocale() }
      if (project && project.title) payload.project = { title: project.title }
      if (sessionId) payload.sessionId = sessionId
      if (recentMessages && recentMessages.length) payload.recent = recentMessages.slice(-4)
      if (baseText && baseText !== text) payload.base = baseText
      try {
        return await postJson(ROUTE + '/enhance', payload, 120000, signal)
      } catch (error) {
        const networkError = error && error.name === 'TypeError' && !error.httpStatus
        const fallback = networkError ? absoluteUrl('/enhance') : ''
        if (!fallback) throw error
        return await postJson(fallback, payload, 120000, signal)
      }
    }

    function sendDiag(event, detail) {
      try {
        const headers = { 'content-type': 'application/json' }
        const token = pageToken()
        if (token) headers['x-pb-token'] = token
        fetch(ROUTE + '/diag', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ event: event, detail: detail || undefined }),
          keepalive: true,
        }).catch(function () {})
      } catch (e) {
        /* 诊断永远不能影响 UI */
      }
    }

    function Sparkle() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M8 1.6c.35 2.6 1.45 3.7 4.05 4.05C9.45 6 8.35 7.1 8 9.7 7.65 7.1 6.55 6 3.95 5.65 6.55 5.3 7.65 4.2 8 1.6Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M12.4 9.9c.18 1.3.72 1.85 2.02 2.02-1.3.18-1.84.72-2.02 2.02-.18-1.3-.72-1.84-2.02-2.02 1.3-.17 1.84-.72 2.02-2.02Z',
          fill: 'currentColor',
          fillOpacity: 0.8,
        }),
      )
    }

    /**
     * 输入框工具栏右侧的「增强」控件。
     * props 由 slot 提供：useInput / inputActions 是 Session 标准 props，t 来自 locale 绑定。
     */
    function EnhanceControl(props) {
      const inputHook = typeof props.useInput === 'function' ? props.useInput : null
      const state = inputHook ? inputHook(function (snapshot) {
        return snapshot
      }) : null
      const draft = state && typeof state.draft === 'string' ? state.draft : ''
      const phase = (state && state.phase) || 'plain'
      const inputActions = props.inputActions
      const project = typeof props.project === 'function' ? props.project() : null
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // 最近对话取自当前页面 Chat 视图（不请求 Host 读取会话历史）
      const chatHook = typeof props.useChat === 'function' ? props.useChat : null
      const chatSnapshot = chatHook
        ? chatHook(function (snapshot) {
            return snapshot
          })
        : null

      const [busy, setBusy] = React.useState(false)
      const [undo, setUndo] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [hovered, setHovered] = React.useState(null)
      const alive = React.useRef(true)
      const draftRef = React.useRef(draft)
      const wrapRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const requestSeq = React.useRef(0)
      const sessionIdRef = React.useRef(sessionId)
      const chatSnapshotRef = React.useRef(chatSnapshot)
      draftRef.current = draft
      sessionIdRef.current = sessionId
      chatSnapshotRef.current = chatSnapshot

      React.useEffect(function () {
        alive.current = true
        return function () {
          alive.current = false
          if (abortRef.current) {
            abortRef.current.abort()
            abortRef.current = null
          }
        }
      }, [])

      React.useEffect(
        function () {
          // 会话切换：中止旧请求并清空状态，避免把旧会话结果回填到新会话
          if (abortRef.current) {
            abortRef.current.abort()
            abortRef.current = null
          }
          setBusy(false)
          setUndo(null)
          setError(null)
        },
        [sessionId],
      )

      React.useEffect(function () {
        const element = wrapRef.current
        sendDiag('client-mounted', {
          rendered: !!element && element.isConnected === true,
          buttons: element ? element.querySelectorAll('button').length : 0,
          sessions: true,
          hardened: true,
          security: 'v3.5',
          tokenPresent: !!pageToken(),
          chatTurns: recentMessagesFrom(chatSnapshotRef.current).turns,
        })
      }, [])

      React.useEffect(
        function () {
          if (!error) return undefined
          const timer = setTimeout(function () {
            setError(null)
          }, 8000)
          return function () {
            clearTimeout(timer)
          }
        },
        [error],
      )

      const t = function (key) {
        return resolveText(props.t, key)
      }

      const canEnhance = !!draft.trim() && phase === 'plain' && !busy && !!inputActions

      function applyEnhanced(enhanced) {
        if (!alive.current) return
        if (typeof inputActions.setDraft !== 'function') {
          setError('当前输入框不支持回填，请刷新页面后重试')
          return
        }
        const before = draftRef.current
        if (before === enhanced) {
          setUndo(null)
          return
        }
        try {
          inputActions.setDraft(enhanced)
          // 连续增强链：versions 按顺序保存每一版；撤销回到最初原句，退改回到上一版
          setUndo(function (previous) {
            if (previous && previous.versions && previous.versions[previous.versions.length - 1] === before) {
              return { original: previous.original, versions: previous.versions.concat(enhanced) }
            }
            return { original: before, versions: [enhanced] }
          })
          setError(null)
          sendDiag('enhance-applied', { charsIn: before.length, charsOut: enhanced.length })
        } catch (e) {
          setError((e && e.message) || String(e))
        }
      }

      function fail(reason) {
        const message = (reason && reason.message) || String(reason)
        if (alive.current) setError(message)
        try {
          console.error('[prompt-booster] enhance failed:', reason)
        } catch (e) {
          /* ignore */
        }
        sendDiag('enhance-failed', { chars: String(message).length })
      }

      function onClick() {
        if (!canEnhance) return
        const seq = requestSeq.current + 1
        requestSeq.current = seq
        const requestSession = sessionId
        const controller = new AbortController()
        abortRef.current = controller
        const textAtRequest = draft
        // 多次增强：当前内容仍是上一版增强结果（未被手动改过）时，带上原句做连续纠正
        const lastVersion = undo && undo.versions ? undo.versions[undo.versions.length - 1] : ''
        const baseText = lastVersion && lastVersion === draft ? undo.original : ''
        const recentInfo = recentMessagesFrom(chatSnapshotRef.current)
        setBusy(true)
        setError(null)
        sendDiag('enhance-click', {
          chars: textAtRequest.length,
          chatTurns: recentInfo.turns,
          hasSession: !!sessionId,
          hasBase: !!baseText,
          tokenPresent: !!pageToken(),
        })
        requestEnhance(textAtRequest, project, sessionId, recentInfo.messages, controller.signal, baseText)
          .then(
            function (result) {
              if (!alive.current || requestSeq.current !== seq || sessionIdRef.current !== requestSession) return
              abortRef.current = null
              setBusy(false)
              const enhanced = result && typeof result.text === 'string' ? result.text.trim() : ''
              if (!enhanced) {
                fail(new Error('模型没有返回可用内容，请重试'))
                return
              }
              applyEnhanced(enhanced)
            },
            function (reason) {
              if (!alive.current || requestSeq.current !== seq || sessionIdRef.current !== requestSession) return
              abortRef.current = null
              setBusy(false)
              if (reason && reason.name === 'AbortError') return
              fail(reason)
            },
          )
          .catch(function (reason) {
            if (!alive.current || requestSeq.current !== seq || sessionIdRef.current !== requestSession) return
            abortRef.current = null
            setBusy(false)
            fail(reason)
          })
      }

      function onUndo() {
        if (!undo || !inputActions || typeof inputActions.setDraft !== 'function') return
        try {
          inputActions.setDraft(undo.original)
          setUndo(null)
          setError(null)
          sendDiag('enhance-undo', { chars: undo.original.length })
        } catch (e) {
          setError((e && e.message) || String(e))
        }
      }

      function onStepBack() {
        if (!undo || !undo.versions || undo.versions.length < 2) return
        if (!inputActions || typeof inputActions.setDraft !== 'function') return
        try {
          const versions = undo.versions.slice(0, -1)
          const target = versions[versions.length - 1]
          inputActions.setDraft(target)
          setUndo({ original: undo.original, versions: versions })
          setError(null)
          sendDiag('enhance-step-back', { chars: target.length })
        } catch (e) {
          setError((e && e.message) || String(e))
        }
      }

      const lastVersion = undo && undo.versions ? undo.versions[undo.versions.length - 1] : ''
      const onLatestVersion = !!lastVersion && draft === lastVersion && !busy
      const stepBackVisible = onLatestVersion && undo.versions.length >= 2
      const undoVisible = onLatestVersion

      const title = busy
        ? t('busyTitle')
        : !draft.trim()
          ? t('emptyTitle')
          : error
            ? error
            : project && project.cwd
              ? t('titleWithContext')
              : t('title')

      const parts = [h('style', { key: 'css' }, CSS)]

      parts.push(
        h(
          'button',
          {
            key: 'enhance',
            type: 'button',
            className: 'pb-btn' + (busy ? ' pb-busy' : '') + (error ? ' pb-error' : ''),
            title: title,
            'aria-label': t('aria'),
            'aria-busy': busy ? 'true' : undefined,
            disabled: !canEnhance,
            onClick: onClick,
            onMouseEnter: function () {
              setHovered('enhance')
            },
            onMouseLeave: function () {
              setHovered(null)
            },
          },
          h(Sparkle, { key: 'icon' }),
          h('span', { key: 'label' }, busy ? t('busyLabel') : t('label')),
        ),
      )

      if (stepBackVisible) {
        parts.push(
          h(
            'button',
            {
              key: 'stepback',
              type: 'button',
              className: 'pb-undo',
              title: t('stepBackTitle'),
              'aria-label': t('stepBackAria'),
              onClick: onStepBack,
            },
            t('stepBackLabel'),
          ),
        )
      }

      if (undoVisible) {
        parts.push(
          h(
            'button',
            {
              key: 'undo',
              type: 'button',
              className: 'pb-undo',
              title: t('undoTitle'),
              'aria-label': t('undoAria'),
              onClick: onUndo,
            },
            t('undoLabel'),
          ),
        )
      }

      if (error) {
        parts.push(
          h(
            'span',
            {
              key: 'error',
              className: 'pb-err',
              title: error,
              role: 'status',
            },
            t('failedLabel'),
          ),
        )
      }

      return h(
        'span',
        {
          className: 'pb-wrap',
          ref: wrapRef,
          'data-prompt-booster': 'v1',
          'data-hovered': hovered || undefined,
        },
        parts,
      )
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        /** 读当前会话所在项目：cwd + 会话标题（Host 据此读取项目上下文）。 */
        function projectOf(sessionId) {
          try {
            const snapshot = ctx.sessions && typeof ctx.sessions.list.getSnapshot === 'function'
              ? ctx.sessions.list.getSnapshot()
              : null
            const summary = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null
            if (!summary) return null
            const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
            const title = typeof summary.displayTitle === 'string'
              ? summary.displayTitle
              : typeof summary.title === 'string'
                ? summary.title
                : ''
            if (!cwd && !title) return null
            return { cwd: cwd, title: title }
          } catch (e) {
            return null
          }
        }

        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(function () {
              return ctx.locale.register(NS, { zh: ZH, en: EN })
            }, 'prompt-booster: dictionaries')
          }
        } catch (e) {
          /* 字典失败时组件回退到内置文案 */
        }

        try {
          ctx.slots.inject(SLOT, function () {
            return ctx.slots.register(
              {
                name: SLOT,
                id: 'prompt-booster',
                order: 20,
                locale: NS,
                inject: function (sessionId) {
                  return {
                    project: function () {
                      return projectOf(sessionId)
                    },
                    sessionId: sessionId,
                  }
                },
              },
              EnhanceControl,
            )
          })
          sendDiag('client-apply', JSON.stringify({ slot: SLOT, sessions: !!ctx.sessions }))
        } catch (e) {
          sendDiag('client-apply-error', (e && e.message) || String(e))
          console.error('[prompt-booster] client apply failed:', e)
        }
      },
    }
  },
})
