import {
	AssistantMessageComponent,
	createAgentSession,
	getMarkdownTheme,
	ToolExecutionComponent,
	UserMessageComponent,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Input, Key, matchesKey, Spacer, Text, type Focusable, type KeybindingsManager, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";

class GhostOverlayComponent extends Container implements Focusable {
	private readonly transcriptContainer: Container;
	private readonly input: Input;
	private readonly status: Text;
	private readonly tui: TUI;
	private readonly theme: ExtensionCommandContext["ui"]["theme"];
	private readonly onSubmitMessage: (text: string) => void;
	private readonly onHideOverlay: () => void;
	private readonly onCloseOverlay: () => void;
	private streamingComponent?: AssistantMessageComponent;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		theme: ExtensionCommandContext["ui"]["theme"],
		keybindings: KeybindingsManager,
		onSubmitMessage: (text: string) => void,
		onHideOverlay: () => void,
		onCloseOverlay: () => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.onSubmitMessage = onSubmitMessage;
		this.onHideOverlay = onHideOverlay;
		this.onCloseOverlay = onCloseOverlay;

		this.addChild(
			new Text(
				theme.fg("accent", theme.bold(" ghost pi ")) +
					" " +
					theme.fg("dim", "same model • no session • ctrl+s hide • esc close"),
				1,
				1,
			),
		);

		this.transcriptContainer = new Container();
		this.addChild(this.transcriptContainer);
		this.addChild(new Spacer(1));

		this.status = new Text(theme.fg("dim", "Ask something quick."), 1, 0);
		this.addChild(this.status);
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.onSubmit = (value) => {
			const text = value.trim();
			if (!text) return;
			this.input.setValue("");
			this.onSubmitMessage(text);
		};
		this.input.onEscape = () => {
			this.onCloseOverlay();
		};

		const originalHandleInput = this.input.handleInput.bind(this.input);
		this.input.handleInput = (data: string) => {
			if (matchesKey(data, Key.ctrl("s"))) {
				this.onHideOverlay();
				return;
			}
			originalHandleInput(data);
		};

		this.addChild(this.input);
	}

	setStatus(text: string): void {
		this.status.setText(this.theme.fg("dim", text));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "user") {
					const text = extractMessageText(event.message);
					this.transcriptContainer.addChild(new UserMessageComponent(text, getMarkdownTheme()));
					this.setStatus("Thinking...");
					break;
				}

				if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...");
					this.transcriptContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message);
					this.setStatus("Streaming response...");
				}
				break;
			}

			case "message_update": {
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingComponent.updateContent(event.message);
				}
				break;
			}

			case "message_end": {
				if (event.message.role !== "assistant") break;
				if (this.streamingComponent) {
					this.streamingComponent.updateContent(event.message);

					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
						const errorMessage = event.message.errorMessage || "Error";
						for (const component of this.pendingTools.values()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						for (const component of this.pendingTools.values()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
				}
				this.setStatus("Ask something quick.");
				break;
			}

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{ showImages: true },
						undefined,
						this.tui,
						process.cwd(),
					);
					this.transcriptContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.setStatus(`Running ${event.toolName}...`);
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}

			case "agent_end": {
				this.streamingComponent = undefined;
				this.pendingTools.clear();
				this.setStatus("Ask something quick.");
				break;
			}
		}

		this.tui.requestRender();
	}
}

function extractMessageText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	let ghostSession: AgentSession | null = null;
	let overlayHandle: OverlayHandle | null = null;
	let overlayClosed = false;

	const cleanupGhost = (ctx?: ExtensionCommandContext) => {
		overlayClosed = true;
		if (overlayHandle) {
			try {
				overlayHandle.hide();
			} catch {
				// ignore
			}
			overlayHandle = null;
		}
		if (ghostSession) {
			ghostSession.dispose();
			ghostSession = null;
		}
		ctx?.ui.setWidget("pi-ghost", undefined);
	};

	const setHiddenState = (ctx: ExtensionCommandContext, hidden: boolean) => {
		if (!overlayHandle) return;
		overlayHandle.setHidden(hidden);
		if (hidden) {
			overlayHandle.unfocus();
			ctx.ui.setWidget(
				"pi-ghost",
				(_tui, theme) => ({
					render: () => [theme.fg("accent", "/gpi ") + theme.fg("dim", "is running • ctrl+s to bring it back")],
					invalidate: () => {},
				}),
				{ placement: "aboveEditor" },
			);
		} else {
			ctx.ui.setWidget("pi-ghost", undefined);
			overlayHandle.focus();
		}
	};

	const ensureGhostSession = async (ctx: ExtensionCommandContext): Promise<AgentSession> => {
		if (ghostSession) return ghostSession;
		if (!ctx.model) throw new Error("No model selected");

		const result = await createAgentSession({
			cwd: ctx.cwd,
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			sessionManager: SessionManager.inMemory(ctx.cwd),
		});
		ghostSession = result.session;
		return ghostSession;
	};

	const openGhostOverlay = async (ctx: ExtensionCommandContext, initialPrompt?: string) => {
		const session = await ensureGhostSession(ctx);
		overlayClosed = false;

		void ctx.ui
			.custom<void>(
				(tui, theme, keybindings, done) => {
					const overlay = new GhostOverlayComponent(
						tui,
						theme,
						keybindings,
						(text) => {
							void session.prompt(text, { images: [] });
						},
						() => {
							setHiddenState(ctx, true);
						},
						() => {
							done();
						},
					);

					const unsubscribe = session.subscribe((event) => {
						overlay.handleSessionEvent(event);
					});

					if (initialPrompt?.trim()) {
						void session.prompt(initialPrompt.trim(), { images: [] });
					}

					return {
						render: (width: number) => overlay.render(width),
						invalidate: () => overlay.invalidate(),
						handleInput: (data: string) => overlay.handleInput(data),
						get focused() {
							return overlay.focused;
						},
						set focused(value: boolean) {
							overlay.focused = value;
						},
						dispose: () => {
							unsubscribe();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "85%",
						maxHeight: "55%",
						margin: { bottom: 1, left: 2, right: 2 },
					},
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			)
			.finally(() => {
				overlayHandle = null;
				if (!overlayClosed) {
					cleanupGhost(ctx);
				}
			});
	};

	pi.registerCommand("gpi", {
		description: "Open ghost pi overlay",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/gpi requires interactive mode", "error");
				return;
			}

			const prompt = args.trim();

			if (overlayHandle) {
				if (overlayHandle.isHidden()) {
					setHiddenState(ctx, false);
				}
				if (prompt) {
					const session = await ensureGhostSession(ctx);
					void session.prompt(prompt, { images: [] });
				}
				return;
			}

			await openGhostOverlay(ctx, prompt || undefined);
		},
	});

	pi.registerShortcut("ctrl+s", {
		description: "Restore hidden ghost pi overlay",
		handler: async (ctx) => {
			const commandCtx = ctx as ExtensionCommandContext;
			if (!overlayHandle) return;
			if (overlayHandle.isHidden()) {
				setHiddenState(commandCtx, false);
				return;
			}
			setHiddenState(commandCtx, true);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanupGhost(ctx as ExtensionCommandContext);
	});
}
