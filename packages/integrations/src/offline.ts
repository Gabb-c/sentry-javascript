import { Event, EventProcessor, Hub, Integration } from '@sentry/types';
import { getGlobalObject, logger, uuid4 } from '@sentry/utils';
// @ts-ignore: Module '"localforage"' has no default export.
import localforage from 'localforage';

/**
 * cache offline errors and send when connected
 */
export class Offline implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'Offline';

  /**
   * @inheritDoc
   */
  public readonly name: string = Offline.id;

  /**
   * the global instance
   */
  public global: Window;

  /**
   * the current hub instance
   */
  public hub?: Hub;

  /**
   * maximum number of events to store while offline
   */
  public maxStoredEvents: number;

  /**
   * event cache
   */
  public offlineEventStore: LocalForage; // type imported from localforage

  /**
   * @inheritDoc
   */
  public constructor(options: { maxStoredEvents?: number } = {}) {
    this.global = getGlobalObject<Window>();
    this.maxStoredEvents = options.maxStoredEvents || 30; // set a reasonable default
    this.offlineEventStore = localforage.createInstance({
      name: 'sentry/offlineEventStore',
    });

    if ('addEventListener' in this.global) {
      this.global.addEventListener('online', () => {
        this._sendEvents().catch(() => {
          logger.warn('could not send cached events');
        });
      });
    }
  }

  /**
   * @inheritDoc
   */
  public setupOnce(addGlobalEventProcessor: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    this.hub = getCurrentHub();

    addGlobalEventProcessor((event: Event) => {
      if (this.hub && this.hub.getIntegration(Offline)) {
        // cache if we are positively offline
        if ('navigator' in this.global && 'onLine' in this.global.navigator && !this.global.navigator.onLine) {
          this._cacheEvent(event)
            .then((_event: Event): Promise<void> => this._enforceMaxEvents())
            .catch((_error): void => {
              logger.warn('could not cache event while offline');
            });

          // return null on success or failure, because being offline will still result in an error
          return null;
        }
      }

      return event;
    });

    // if online now, send any events stored in a previous offline session
    if ('navigator' in this.global && 'onLine' in this.global.navigator && this.global.navigator.onLine) {
      this._sendEvents().catch(() => {
        logger.warn('could not send cached events');
      });
    }
  }

  /**
   * cache an event to send later
   * @param event an event
   */
  private async _cacheEvent(event: Event): Promise<Event> {
    return this.offlineEventStore.setItem<Event>(uuid4(), event);
  }

  /**
   * purge excess events if necessary
   */
  private async _enforceMaxEvents(): Promise<void> {
    const events: Array<{ event: Event; cacheKey: string }> = [];

    return this.offlineEventStore
      .iterate<Event, void>((event: Event, cacheKey: string, _index: number): void => {
        // aggregate events
        events.push({ cacheKey, event });
      })
      .then(
        (): Promise<void> =>
          // this promise resolves when the iteration is finished
          this._purgeEvents(
            // purge all events past maxStoredEvents in reverse chronological order
            events
              .sort((a, b) => (b.event.timestamp || 0) - (a.event.timestamp || 0))
              .slice(this.maxStoredEvents < events.length ? this.maxStoredEvents : events.length)
              .map(event => event.cacheKey),
          ),
      )
      .catch((_error): void => {
        logger.warn('could not enforce max events');
      });
  }

  /**
   * purge event from cache
   */
  private async _purgeEvent(cacheKey: string): Promise<void> {
    return this.offlineEventStore.removeItem(cacheKey);
  }

  /**
   * purge events from cache
   */
  private async _purgeEvents(cacheKeys: string[]): Promise<void> {
    // trail with .then to ensure the return type as void and not void|void[]
    return Promise.all(cacheKeys.map(cacheKey => this._purgeEvent(cacheKey))).then();
  }

  /**
   * send all events
   */
  private async _sendEvents(): Promise<void> {
    return this.offlineEventStore.iterate<Event, void>((event: Event, cacheKey: string, _index: number): void => {
      if (this.hub) {
        const newEventId = this.hub.captureEvent(event);

        if (newEventId) {
          this._purgeEvent(cacheKey).catch((_error): void => {
            logger.warn('could not purge event from cache');
          });
        }
      } else {
        logger.warn('no hub found - could not send cached event');
      }
    });
  }
}
