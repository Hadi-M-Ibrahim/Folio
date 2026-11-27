import { Component, createRef, type ReactNode } from 'react';

type Props = { resolvedCount: number; children: ReactNode };
type Positions = Map<HTMLElement, number>;
const visibleItems = 'section:not([hidden]) > .queue-item, .resolved-disclosure';

export class FindingListMotion extends Component<Props> {
  private list = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: Props): Positions | null {
    const list = this.list.current;
    if (previous.resolvedCount === this.props.resolvedCount || !list?.offsetWidth ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

    // Capture visible positions before React moves a finding, including any unfinished slide.
    const top = list.getBoundingClientRect().top;
    const items = list.querySelectorAll<HTMLElement>(visibleItems);
    return new Map(Array.from(items, item => [item, item.getBoundingClientRect().top - top]));
  }

  componentDidUpdate(_previous: Props, _state: unknown, before: Positions | null) {
    const list = this.list.current;
    if (!before || !list) return;

    for (const animation of list.getAnimations({ subtree: true })) {
      if (animation.id === 'finding-reflow') animation.cancel();
    }
    const top = list.getBoundingClientRect().top;
    const shifts = new Map<HTMLElement, number>();
    const arriving: HTMLElement[] = [];
    for (const item of list.querySelectorAll<HTMLElement>(visibleItems)) {
      const previousTop = before.get(item);
      if (previousTop === undefined) arriving.push(item);
      else {
        const shift = previousTop - (item.getBoundingClientRect().top - top);
        if (Math.abs(shift) > 1) shifts.set(item, shift);
      }
    }
    for (const [item, shift] of shifts) {
      item.animate([{ transform: 'translateY(' + shift + 'px)' }, { transform: 'none' }], {
        id: 'finding-reflow', duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
      });
    }
    for (const item of arriving) {
      item.animate([{ opacity: 0 }, { opacity: 1 }], {
        id: 'finding-reflow', duration: 130, delay: 90, fill: 'backwards',
      });
    }
  }

  render() {
    return <div ref={this.list}>{this.props.children}</div>;
  }
}
