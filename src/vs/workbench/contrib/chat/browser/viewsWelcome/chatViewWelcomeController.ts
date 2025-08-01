/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Event } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IMarkdownRenderResult, MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { localize } from '../../../../../nls.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IChatWidgetService } from '../chat.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { chatViewsWelcomeRegistry, IChatViewsWelcomeDescriptor } from './chatViewsWelcome.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';

const $ = dom.$;

export interface IViewWelcomeDelegate {
	readonly onDidChangeViewWelcomeState: Event<void>;
	shouldShowWelcome(): boolean;
}

export class ChatViewWelcomeController extends Disposable {
	private element: HTMLElement | undefined;

	private enabled = false;
	private readonly enabledDisposables = this._register(new DisposableStore());
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		private readonly delegate: IViewWelcomeDelegate,
		private readonly location: ChatAgentLocation,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IInstantiationService private instantiationService: IInstantiationService,
	) {
		super();

		this.element = dom.append(this.container, dom.$('.chat-view-welcome'));
		this._register(Event.runAndSubscribe(
			delegate.onDidChangeViewWelcomeState,
			() => this.update()));
		this._register(chatViewsWelcomeRegistry.onDidChange(() => this.update(true)));
	}

	private update(force?: boolean): void {
		const enabled = this.delegate.shouldShowWelcome();
		if (this.enabled === enabled && !force) {
			return;
		}

		this.enabled = enabled;
		this.enabledDisposables.clear();

		if (!enabled) {
			this.container.classList.toggle('chat-view-welcome-visible', false);
			this.renderDisposables.clear();
			return;
		}

		const descriptors = chatViewsWelcomeRegistry.get();
		if (descriptors.length) {
			this.render(descriptors);

			const descriptorKeys: Set<string> = new Set(descriptors.flatMap(d => d.when.keys()));
			this.enabledDisposables.add(this.contextKeyService.onDidChangeContext(e => {
				if (e.affectsSome(descriptorKeys)) {
					this.render(descriptors);
				}
			}));
		}
	}

	private render(descriptors: ReadonlyArray<IChatViewsWelcomeDescriptor>): void {
		this.renderDisposables.clear();
		dom.clearNode(this.element!);

		const matchingDescriptors = descriptors.filter(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));
		let enabledDescriptor: IChatViewsWelcomeDescriptor | undefined;
		for (const descriptor of matchingDescriptors) {
			if (typeof descriptor.content === 'function') {
				enabledDescriptor = descriptor; // when multiple descriptors match, prefer a "core" one over a "descriptive" one
				break;
			}
		}
		enabledDescriptor = enabledDescriptor ?? matchingDescriptors.at(0);
		if (enabledDescriptor) {
			const content: IChatViewWelcomeContent = {
				icon: enabledDescriptor.icon,
				title: enabledDescriptor.title,
				message: enabledDescriptor.content
			};
			const welcomeView = this.renderDisposables.add(this.instantiationService.createInstance(ChatViewWelcomePart, content, { firstLinkToButton: true, location: this.location }));
			this.element!.appendChild(welcomeView.element);
			this.container.classList.toggle('chat-view-welcome-visible', true);
		} else {
			this.container.classList.toggle('chat-view-welcome-visible', false);
		}
	}
}

export interface IChatViewWelcomeContent {
	icon?: ThemeIcon;
	title: string;
	message: IMarkdownString | ((disposables: DisposableStore) => HTMLElement);
	additionalMessage?: string | IMarkdownString;
	tips?: IMarkdownString;
	inputPart?: HTMLElement;
	isExperimental?: boolean;
	suggestedPrompts?: IChatSuggestedPrompts[];
}

export interface IChatSuggestedPrompts {
	icon?: ThemeIcon;
	label: string;
	prompt: string;
}

export interface IChatViewWelcomeRenderOptions {
	firstLinkToButton?: boolean;
	location: ChatAgentLocation;
	isWidgetAgentWelcomeViewContent?: boolean;
}

export class ChatViewWelcomePart extends Disposable {
	public readonly element: HTMLElement;

	constructor(
		public readonly content: IChatViewWelcomeContent,
		options: IChatViewWelcomeRenderOptions | undefined,
		@IOpenerService private openerService: IOpenerService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@ILogService private logService: ILogService,
		@IChatWidgetService private chatWidgetService: IChatWidgetService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IConfigurationService private configurationService: IConfigurationService,
	) {
		super();
		this.element = dom.$('.chat-welcome-view');

		try {
			const renderer = this.instantiationService.createInstance(MarkdownRenderer, {});

			// Icon
			const icon = dom.append(this.element, $('.chat-welcome-view-icon'));
			if (content.icon) {
				icon.appendChild(renderIcon(content.icon));
			}

			// Title
			const title = dom.append(this.element, $('.chat-welcome-view-title'));
			title.textContent = content.title;

			// Preview indicator
			const expEmptyState = this.configurationService.getValue<boolean>('chat.emptyChatState.enabled');
			if (typeof content.message !== 'function' && options?.isWidgetAgentWelcomeViewContent && !expEmptyState) {
				const container = dom.append(this.element, $('.chat-welcome-view-indicator-container'));
				dom.append(container, $('.chat-welcome-view-subtitle', undefined, localize('agentModeSubtitle', "Agent Mode")));
			}

			// Message
			const message = dom.append(this.element, content.isExperimental ? $('.chat-welcome-experimental-view-message') : $('.chat-welcome-view-message'));
			message.classList.toggle('experimental-empty-state', expEmptyState);
			if (typeof content.message === 'function') {
				dom.append(message, content.message(this._register(new DisposableStore())));
			} else {
				const messageResult = this.renderMarkdownMessageContent(renderer, content.message, options);
				dom.append(message, messageResult.element);
			}

			if (content.isExperimental && content.inputPart) {
				content.inputPart.querySelector('.chat-attachments-container')?.remove();
				dom.append(this.element, content.inputPart);

				if (content.suggestedPrompts && content.suggestedPrompts.length) {
					// create a tile with icon and label for each suggested promot
					const suggestedPromptsContainer = dom.append(this.element, $('.chat-welcome-view-suggested-prompts'));
					for (const prompt of content.suggestedPrompts) {
						const promptElement = dom.append(suggestedPromptsContainer, $('.chat-welcome-view-suggested-prompt'));
						// Make the prompt element keyboard accessible
						promptElement.setAttribute('role', 'button');
						promptElement.setAttribute('tabindex', '0');
						promptElement.setAttribute('aria-label', localize('suggestedPromptAriaLabel', 'Suggested prompt: {0}', prompt.label));
						if (prompt.icon) {
							const iconElement = dom.append(promptElement, $('.chat-welcome-view-suggested-prompt-icon'));
							iconElement.appendChild(renderIcon(prompt.icon));
						}
						const labelElement = dom.append(promptElement, $('.chat-welcome-view-suggested-prompt-label'));
						labelElement.textContent = prompt.label;
						const executePrompt = () => {
							type SuggestedPromptClickEvent = { suggestedPrompt: string };

							type SuggestedPromptClickData = {
								owner: 'bhavyaus';
								comment: 'Event used to gain insights into when suggested prompts are clicked.';
								suggestedPrompt: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The suggested prompt clicked.' };
							};

							this.telemetryService.publicLog2<SuggestedPromptClickEvent, SuggestedPromptClickData>('chat.clickedSuggestedPrompt', {
								suggestedPrompt: prompt.prompt,
							});

							if (!this.chatWidgetService.lastFocusedWidget) {
								const widgets = this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Panel);
								if (widgets.length) {
									widgets[0].setInput(prompt.prompt);
								}
							} else {
								this.chatWidgetService.lastFocusedWidget.setInput(prompt.prompt);
							}
						};
						// Add click handler
						this._register(dom.addDisposableListener(promptElement, dom.EventType.CLICK, executePrompt));
						// Add keyboard handler for Enter and Space keys
						this._register(dom.addDisposableListener(promptElement, dom.EventType.KEY_DOWN, (e) => {
							const event = new StandardKeyboardEvent(e);
							if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
								e.preventDefault();
								e.stopPropagation();
								executePrompt();
							}
						}));
					}
				}

				if (typeof content.additionalMessage === 'string') {
					const additionalMsg = $('.chat-welcome-view-experimental-additional-message');
					additionalMsg.textContent = content.additionalMessage;
					dom.append(this.element, additionalMsg);
				}
			} else {
				// Additional message
				if (typeof content.additionalMessage === 'string') {
					const element = $('');
					element.textContent = content.additionalMessage;
					dom.append(message, element);
				} else if (content.additionalMessage) {
					const additionalMessageResult = this.renderMarkdownMessageContent(renderer, content.additionalMessage, options);
					dom.append(message, additionalMessageResult.element);
				}
			}

			// Tips
			if (content.tips) {
				const tips = dom.append(this.element, $('.chat-welcome-view-tips'));
				const tipsResult = this._register(renderer.render(content.tips));
				tips.appendChild(tipsResult.element);
			}
		} catch (err) {
			this.logService.error('Failed to render chat view welcome content', err);
		}
	}

	private renderMarkdownMessageContent(renderer: MarkdownRenderer, content: IMarkdownString, options: IChatViewWelcomeRenderOptions | undefined): IMarkdownRenderResult {
		const messageResult = this._register(renderer.render(content));
		const firstLink = options?.firstLinkToButton ? messageResult.element.querySelector('a') : undefined;
		if (firstLink) {
			const target = firstLink.getAttribute('data-href');
			const button = this._register(new Button(firstLink.parentElement!, defaultButtonStyles));
			button.label = firstLink.textContent ?? '';
			if (target) {
				this._register(button.onDidClick(() => {
					this.openerService.open(target, { allowCommands: true });
				}));
			}
			firstLink.replaceWith(button.element);
		}
		return messageResult;
	}
}
