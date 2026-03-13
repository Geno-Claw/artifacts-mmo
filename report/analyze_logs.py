#!/usr/bin/env python3
"""Analyze Artifacts MMO runtime logs for daily summary."""

import json
import sys
import re
from collections import defaultdict
from datetime import datetime

def analyze_log_file(filepath):
    # Per-character stats
    chars = defaultdict(lambda: {
        'actions': 0,
        'xp_gained': defaultdict(int),  # skill/type -> xp
        'gold_gained': 0,
        'gold_spent': 0,
        'fights': {'wins': defaultdict(int), 'losses': defaultdict(int)},
        'items_gathered': defaultdict(int),
        'items_crafted': defaultdict(int),
        'items_dropped': defaultdict(int),
        'level_ups': [],
        'deaths': 0,
        'first_seen': None,
        'last_seen': None,
        'movements': 0,
        'routines': set(),
        'api_calls': 0,
    })
    
    # Global stats
    warnings = defaultdict(int)
    errors = []
    notable_events = []
    action_times = defaultdict(list)  # char -> list of timestamps
    
    line_count = 0
    parse_errors = 0
    
    with open(filepath, 'r') as f:
        for line in f:
            line_count += 1
            try:
                entry = json.loads(line.strip())
            except json.JSONDecodeError:
                parse_errors += 1
                continue
            
            level = entry.get('level', 'info')
            message = entry.get('message', '') or ''
            context = entry.get('context') or {}
            data = entry.get('data') or {}
            event = entry.get('event') or ''
            iso = entry.get('iso', '')
            scope = entry.get('scope') or ''
            
            char = context.get('character', '')
            if not char and message.startswith('['):
                # Extract character from message like "[GenoClaw4] ..."
                match = re.match(r'\[([^\]]+)\]', message)
                if match:
                    char = match.group(1)
            
            if not char:
                char = 'unknown'
            
            routine = context.get('routine', '')
            action = context.get('action', '')
            
            # Track timing
            if char != 'unknown':
                if chars[char]['first_seen'] is None:
                    chars[char]['first_seen'] = iso
                chars[char]['last_seen'] = iso
                if routine:
                    chars[char]['routines'].add(routine)
            
            # Track warnings
            if level == 'warn':
                key = message[:100] if len(message) > 100 else message
                warnings[f"{char}: {key}"] += 1
            
            # Track errors
            if level == 'error':
                errors.append({
                    'time': iso,
                    'char': char,
                    'message': message[:200],
                    'error': str(entry.get('error', {}))[:200]
                })
            
            # Track API calls / actions completed
            if event == 'api.action.result':
                chars[char]['actions'] += 1
                chars[char]['api_calls'] += 1
                if iso:
                    action_times[char].append(iso)
                
                detail = data.get('detail') or {}
                action_type = data.get('type', '')
                
                # XP from action result
                xp = detail.get('xp', 0)
                if xp and isinstance(xp, (int, float)):
                    chars[char]['xp_gained'][action_type or 'unknown'] += int(xp)
                
                # Gold from action result
                gold = detail.get('gold', 0)
                if gold and isinstance(gold, (int, float)):
                    chars[char]['gold_gained'] += int(gold)
                
                # Fight results
                if action_type == 'fight':
                    result = detail.get('result', '')
                    monster = detail.get('monster', 'unknown')
                    if result == 'win':
                        chars[char]['fights']['wins'][monster] += 1
                    elif result in ('loss', 'lose'):
                        chars[char]['fights']['losses'][monster] += 1
                    
                    # Drops from fight
                    drops = detail.get('drops') or []
                    for drop in drops:
                        if isinstance(drop, dict):
                            item = drop.get('code', 'unknown')
                            qty = drop.get('qty', drop.get('quantity', 1))
                            chars[char]['items_dropped'][item] += qty
                
                # Gathering results
                if action_type == 'gathering':
                    drops = detail.get('drops') or []
                    for drop in drops:
                        if isinstance(drop, dict):
                            item = drop.get('code', 'unknown')
                            qty = drop.get('qty', drop.get('quantity', 1))
                            chars[char]['items_gathered'][item] += qty
                
                # Crafting results
                if action_type == 'crafting':
                    item = detail.get('item', 'unknown')
                    qty = detail.get('quantity', 1)
                    if item != 'unknown':
                        chars[char]['items_crafted'][item] += qty
            
            # Track combat progress events (alternative source)
            if event == 'combat.claim.progress':
                xp = data.get('xp', 0)
                gold = data.get('gold', 0)
                monster = data.get('monsterCode', 'unknown')
                drops_str = data.get('drops', '')
                
                # Parse drops string if present
                if drops_str:
                    for match in re.finditer(r'(\w+)x(\d+)', drops_str):
                        item, qty = match.groups()
                        chars[char]['items_dropped'][item] += int(qty)
            
            # Track gather progress events
            if event == 'gather.claim.progress':
                items = data.get('items') or []
                for item in items:
                    if isinstance(item, dict):
                        code = item.get('code', 'unknown')
                        qty = item.get('quantity', 1)
                        # Already counted in api.action.result
            
            # Track craft completion
            if event == 'craft.recipe.completed':
                # Already counted in api.action.result
                pass
            
            # Track level ups
            if event == 'level_up' or 'level up' in message.lower() or 'leveled up' in message.lower():
                skill = data.get('skill', 'unknown')
                new_level = data.get('level', data.get('new_level', '?'))
                chars[char]['level_ups'].append({'skill': skill, 'level': new_level, 'time': iso})
                notable_events.append(f"[{iso}] {char}: Level up! {skill} -> {new_level}")
            
            # Track deaths
            if 'death' in message.lower() and 'death_knight' not in message.lower():
                if 'died' in message.lower() or 'you died' in message.lower():
                    chars[char]['deaths'] += 1
                    notable_events.append(f"[{iso}] {char}: DEATH")
            
            # Track movements
            if event == 'api.action.result' and data.get('type') == 'move':
                chars[char]['movements'] += 1
            elif 'moving to' in message.lower():
                chars[char]['movements'] += 1
    
    return {
        'chars': dict(chars),
        'warnings': dict(warnings),
        'errors': errors,
        'notable_events': notable_events,
        'action_times': dict(action_times),
        'line_count': line_count,
        'parse_errors': parse_errors,
    }


def calculate_efficiency(action_times):
    """Calculate actions per hour for each character."""
    efficiency = {}
    for char, times in action_times.items():
        if len(times) < 2:
            efficiency[char] = {'actions_per_hour': 'N/A', 'total_actions': len(times)}
            continue
        try:
            first = datetime.fromisoformat(times[0].replace('Z', '+00:00'))
            last = datetime.fromisoformat(times[-1].replace('Z', '+00:00'))
            hours = (last - first).total_seconds() / 3600
            if hours > 0:
                efficiency[char] = {
                    'actions_per_hour': round(len(times) / hours, 1),
                    'total_actions': len(times),
                    'active_hours': round(hours, 2)
                }
            else:
                efficiency[char] = {'actions_per_hour': 'N/A', 'total_actions': len(times)}
        except:
            efficiency[char] = {'actions_per_hour': 'N/A', 'total_actions': len(times)}
    return efficiency


def print_report(results):
    print("=" * 70)
    print("ARTIFACTS MMO DAILY LOG ANALYSIS - 2026-03-13")
    print("=" * 70)
    print(f"\nLog Statistics: {results['line_count']:,} lines processed, {results['parse_errors']} parse errors")
    
    # Per-character summary
    print("\n" + "=" * 70)
    print("PER-CHARACTER SUMMARY")
    print("=" * 70)
    
    for char, stats in sorted(results['chars'].items()):
        if char == 'unknown':
            continue
        print(f"\n### {char.upper()} ###")
        print(f"  Active: {stats['first_seen'][:19] if stats['first_seen'] else 'N/A'} to {stats['last_seen'][:19] if stats['last_seen'] else 'N/A'}")
        print(f"  Routines: {', '.join(sorted(stats['routines'])) if stats['routines'] else 'None'}")
        print(f"  Actions: {stats['actions']:,} | Movements: {stats['movements']:,} | API Calls: {stats['api_calls']:,}")
        
        # XP
        total_xp = sum(stats['xp_gained'].values())
        if stats['xp_gained']:
            print(f"  XP Gained: {total_xp:,} total")
            for skill, xp in sorted(stats['xp_gained'].items(), key=lambda x: -x[1]):
                print(f"    - {skill}: {xp:,}")
        
        # Gold
        net_gold = stats['gold_gained'] - stats['gold_spent']
        if stats['gold_gained'] or stats['gold_spent']:
            print(f"  Gold: +{stats['gold_gained']:,} / -{stats['gold_spent']:,} (net: {net_gold:+,})")
        
        # Fights
        total_wins = sum(stats['fights']['wins'].values())
        total_losses = sum(stats['fights']['losses'].values())
        if total_wins or total_losses:
            win_rate = (total_wins / (total_wins + total_losses) * 100) if (total_wins + total_losses) > 0 else 0
            print(f"  Fights: {total_wins} wins / {total_losses} losses ({win_rate:.1f}% win rate)")
            if stats['fights']['wins']:
                print("    Wins by monster:")
                for monster, count in sorted(stats['fights']['wins'].items(), key=lambda x: -x[1])[:10]:
                    print(f"      - {monster}: {count}")
            if stats['fights']['losses']:
                print("    Losses by monster:")
                for monster, count in sorted(stats['fights']['losses'].items(), key=lambda x: -x[1]):
                    print(f"      - {monster}: {count}")
        
        # Gathering
        total_gathered = sum(stats['items_gathered'].values())
        if stats['items_gathered']:
            print(f"  Items Gathered: {total_gathered:,}")
            for item, qty in sorted(stats['items_gathered'].items(), key=lambda x: -x[1])[:10]:
                print(f"    - {item}: {qty}")
        
        # Crafting
        total_crafted = sum(stats['items_crafted'].values())
        if stats['items_crafted']:
            print(f"  Items Crafted: {total_crafted:,}")
            for item, qty in sorted(stats['items_crafted'].items(), key=lambda x: -x[1])[:10]:
                print(f"    - {item}: {qty}")
        
        # Drops
        total_drops = sum(stats['items_dropped'].values())
        if stats['items_dropped']:
            print(f"  Item Drops (from fights): {total_drops:,}")
            for item, qty in sorted(stats['items_dropped'].items(), key=lambda x: -x[1])[:10]:
                print(f"    - {item}: {qty}")
        
        # Level ups
        if stats['level_ups']:
            print(f"  Level Ups: {len(stats['level_ups'])}")
            for lu in stats['level_ups']:
                print(f"    - {lu['skill']} -> {lu['level']} @ {lu['time'][:19] if lu['time'] else 'N/A'}")
        
        # Deaths
        if stats['deaths']:
            print(f"  DEATHS: {stats['deaths']}")
    
    # Efficiency
    print("\n" + "=" * 70)
    print("EFFICIENCY (Actions/Hour)")
    print("=" * 70)
    efficiency = calculate_efficiency(results['action_times'])
    for char, eff in sorted(efficiency.items()):
        if char == 'unknown':
            continue
        active = f"over {eff.get('active_hours', 'N/A')} hrs" if eff.get('active_hours') else ""
        print(f"  {char}: {eff['actions_per_hour']} actions/hr ({eff['total_actions']} total {active})")
    
    # Warnings summary
    print("\n" + "=" * 70)
    print("WARNINGS SUMMARY (Top 20 by frequency)")
    print("=" * 70)
    total_warnings = sum(results['warnings'].values())
    print(f"Total warnings: {total_warnings:,}")
    for warn, count in sorted(results['warnings'].items(), key=lambda x: -x[1])[:20]:
        print(f"  [{count:,}x] {warn[:80]}")
    
    # Errors
    print("\n" + "=" * 70)
    print(f"ERRORS ({len(results['errors'])} total)")
    print("=" * 70)
    if results['errors']:
        for err in results['errors'][:30]:
            print(f"  [{err['time'][:19] if err['time'] else 'N/A'}] {err['char']}: {err['message'][:60]}")
            if err['error'] and err['error'] != '{}':
                print(f"    -> {err['error'][:80]}")
        if len(results['errors']) > 30:
            print(f"  ... and {len(results['errors']) - 30} more errors")
    else:
        print("  No errors recorded!")
    
    # Notable events
    print("\n" + "=" * 70)
    print("NOTABLE EVENTS (Level Ups, Deaths, etc.)")
    print("=" * 70)
    if results['notable_events']:
        for event in results['notable_events'][:50]:
            print(f"  {event}")
        if len(results['notable_events']) > 50:
            print(f"  ... and {len(results['notable_events']) - 50} more events")
    else:
        print("  No notable events recorded.")
    
    # Summary totals
    print("\n" + "=" * 70)
    print("DAILY TOTALS")
    print("=" * 70)
    total_actions = sum(s['actions'] for s in results['chars'].values() if s)
    total_xp = sum(sum(s['xp_gained'].values()) for s in results['chars'].values() if s)
    total_gold = sum(s['gold_gained'] for s in results['chars'].values() if s)
    total_fights_won = sum(sum(s['fights']['wins'].values()) for s in results['chars'].values() if s)
    total_fights_lost = sum(sum(s['fights']['losses'].values()) for s in results['chars'].values() if s)
    total_gathered = sum(sum(s['items_gathered'].values()) for s in results['chars'].values() if s)
    total_crafted = sum(sum(s['items_crafted'].values()) for s in results['chars'].values() if s)
    total_drops = sum(sum(s['items_dropped'].values()) for s in results['chars'].values() if s)
    total_level_ups = sum(len(s['level_ups']) for s in results['chars'].values() if s)
    
    print(f"  Total Actions: {total_actions:,}")
    print(f"  Total XP Gained: {total_xp:,}")
    print(f"  Total Gold Gained: {total_gold:,}")
    print(f"  Total Fights: {total_fights_won:,} wins / {total_fights_lost:,} losses")
    print(f"  Total Items Gathered: {total_gathered:,}")
    print(f"  Total Items Crafted: {total_crafted:,}")
    print(f"  Total Item Drops: {total_drops:,}")
    print(f"  Total Level Ups: {total_level_ups}")


if __name__ == '__main__':
    filepath = sys.argv[1] if len(sys.argv) > 1 else '/home/claw/artifacts-mmo/report/logs/runtime-2026-03-13.jsonl'
    print(f"Analyzing: {filepath}")
    results = analyze_log_file(filepath)
    print_report(results)
