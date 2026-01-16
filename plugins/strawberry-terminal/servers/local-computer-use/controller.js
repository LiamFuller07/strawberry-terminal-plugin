/**
 * Local Computer Controller
 *
 * Controls the LOCAL Mac desktop using native macOS tools and robotjs.
 * This is different from the trycua-mcp which controls remote VMs.
 */
import { exec, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
const execAsync = promisify(exec);
// Key mapping for special keys
const KEY_MAP = {
    'enter': 'Return',
    'return': 'Return',
    'tab': 'Tab',
    'escape': 'Escape',
    'esc': 'Escape',
    'space': 'space',
    'backspace': 'Delete',
    'delete': 'ForwardDelete',
    'up': 'Up',
    'down': 'Down',
    'left': 'Left',
    'right': 'Right',
    'home': 'Home',
    'end': 'End',
    'pageup': 'PageUp',
    'pagedown': 'PageDown',
    'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
    'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
    'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
    'cmd': 'command', 'command': 'command',
    'ctrl': 'control', 'control': 'control',
    'alt': 'option', 'option': 'option',
    'shift': 'shift',
};
/**
 * Local Computer Controller
 *
 * Provides screenshot capture and mouse/keyboard control for the local Mac.
 */
export class LocalComputerController {
    config;
    tempDir;
    robotjs = null;
    robotjsLoadError = null;
    hasAccessibilityPermissions = null;
    constructor(config = {}) {
        this.config = {
            debug: false,
            screenshotFormat: 'png',
            actionDelay: 50,
            includeCursor: false,
            ...config,
        };
        this.tempDir = path.join(os.tmpdir(), 'strawberry-local-cu');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        // Try to load robotjs (optional - will fallback to AppleScript if not available)
        this.loadRobotjs();
    }
    /**
     * Try to load robotjs for mouse/keyboard control
     */
    async loadRobotjs() {
        try {
            // Dynamic import for robotjs
            const robotjs = await import('@jitsi/robotjs');
            this.robotjs = robotjs.default || robotjs;
            this.log('robotjs loaded successfully');
        }
        catch (error) {
            this.robotjsLoadError = error instanceof Error ? error.message : String(error);
            this.log(`robotjs not available: ${this.robotjsLoadError}`);
            this.log('Will use AppleScript fallbacks for mouse/keyboard control');
        }
    }
    /**
     * Check if robotjs is available
     */
    hasRobotjs() {
        return this.robotjs !== null;
    }
    /**
     * Check accessibility permissions (required for mouse/keyboard control)
     */
    async checkAccessibilityPermissions() {
        if (this.hasAccessibilityPermissions !== null) {
            return this.hasAccessibilityPermissions;
        }
        try {
            // Try a simple AppleScript that requires accessibility
            await execAsync(`osascript -e 'tell application "System Events" to get the name of the first process'`);
            this.hasAccessibilityPermissions = true;
        }
        catch {
            this.hasAccessibilityPermissions = false;
        }
        return this.hasAccessibilityPermissions;
    }
    /**
     * Get display information
     */
    async getDisplayInfo() {
        try {
            // Use system_profiler to get display info
            const { stdout } = await execAsync(`system_profiler SPDisplaysDataType -json 2>/dev/null`);
            const data = JSON.parse(stdout);
            const displays = [];
            const graphics = data.SPDisplaysDataType || [];
            let displayId = 1;
            for (const gpu of graphics) {
                const gpuDisplays = gpu.spdisplays_ndrvs || [];
                for (const display of gpuDisplays) {
                    const resolution = display._spdisplays_resolution || '';
                    const match = resolution.match(/(\d+)\s*x\s*(\d+)/);
                    if (match) {
                        displays.push({
                            id: displayId++,
                            width: parseInt(match[1], 10),
                            height: parseInt(match[2], 10),
                            scale: display._spdisplays_pixelresolution?.includes('Retina') ? 2 : 1,
                            isPrimary: display._spdisplays_main === 'spdisplays_yes',
                        });
                    }
                }
            }
            // Fallback if no displays found
            if (displays.length === 0) {
                const { stdout: screenSize } = await execAsync(`osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null || echo "0, 0, 1920, 1080"`);
                const bounds = screenSize.trim().split(',').map((n) => parseInt(n.trim(), 10));
                displays.push({
                    id: 1,
                    width: bounds[2] || 1920,
                    height: bounds[3] || 1080,
                    scale: 2, // Assume Retina
                    isPrimary: true,
                });
            }
            return displays;
        }
        catch (error) {
            this.log(`Error getting display info: ${error}`);
            // Return default
            return [{
                    id: 1,
                    width: 1920,
                    height: 1080,
                    scale: 2,
                    isPrimary: true,
                }];
        }
    }
    /**
     * Take a screenshot of the screen
     */
    async screenshot(displayId = 1) {
        const timestamp = Date.now();
        const filename = `screenshot_${timestamp}.${this.config.screenshotFormat}`;
        const filepath = path.join(this.tempDir, filename);
        try {
            // Build screencapture command
            const args = [
                '-x', // No sound
            ];
            if (this.config.includeCursor) {
                args.push('-C'); // Include cursor
            }
            // Specify display
            args.push('-D', String(displayId));
            // Specify format
            args.push('-t', this.config.screenshotFormat === 'jpg' ? 'jpg' : 'png');
            args.push(filepath);
            // Execute screencapture
            execSync(`screencapture ${args.join(' ')}`);
            // Read the file and convert to base64
            const imageBuffer = fs.readFileSync(filepath);
            const imageB64 = imageBuffer.toString('base64');
            // Get dimensions from the image (simple PNG/JPG header parsing)
            const dimensions = await this.getImageDimensions(filepath);
            // Get cursor position
            const cursorPosition = await this.getCursorPosition();
            // Clean up temp file
            try {
                fs.unlinkSync(filepath);
            }
            catch {
                // Ignore cleanup errors
            }
            return {
                imageB64,
                format: this.config.screenshotFormat || 'png',
                timestamp: new Date(timestamp),
                dimensions,
                cursorPosition,
            };
        }
        catch (error) {
            throw new Error(`Screenshot failed: ${error instanceof Error ? error.message : error}`);
        }
    }
    /**
     * Get image dimensions from file
     */
    async getImageDimensions(filepath) {
        try {
            // Use sips to get dimensions
            const { stdout } = await execAsync(`sips -g pixelWidth -g pixelHeight "${filepath}" 2>/dev/null`);
            const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
            const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
            if (widthMatch && heightMatch) {
                return {
                    width: parseInt(widthMatch[1], 10),
                    height: parseInt(heightMatch[1], 10),
                };
            }
        }
        catch {
            // Ignore errors
        }
        // Fallback to display info
        const displays = await this.getDisplayInfo();
        return {
            width: displays[0]?.width || 1920,
            height: displays[0]?.height || 1080,
        };
    }
    /**
     * Get current cursor position
     */
    async getCursorPosition() {
        if (this.robotjs) {
            try {
                const pos = this.robotjs.getMousePos();
                return { x: pos.x, y: pos.y };
            }
            catch {
                // Fallback to AppleScript
            }
        }
        // AppleScript fallback - this is less reliable but works without robotjs
        try {
            const script = `
        use framework "Foundation"
        use framework "AppKit"
        set mouseLocation to current application's NSEvent's mouseLocation()
        set screenHeight to (current application's NSScreen's mainScreen()'s frame()'s |size|()'s height) as integer
        set x to (mouseLocation's x) as integer
        set y to (screenHeight - (mouseLocation's y)) as integer
        return (x as text) & "," & (y as text)
      `;
            const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
            const [x, y] = stdout.trim().split(',').map((n) => parseInt(n, 10));
            return { x: x || 0, y: y || 0 };
        }
        catch (error) {
            this.log(`Error getting cursor position: ${error}`);
            return { x: 0, y: 0 };
        }
    }
    /**
     * Move mouse to coordinates
     */
    async moveMouse(x, y) {
        if (this.robotjs) {
            this.robotjs.moveMouse(x, y);
            return;
        }
        // AppleScript fallback using cliclick if available, otherwise manual
        try {
            // Try cliclick first (fast)
            await execAsync(`cliclick m:${x},${y} 2>/dev/null`);
        }
        catch {
            // Fallback to CGEvent via Python (more reliable than AppleScript)
            const script = `
import Quartz
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
`;
            await execAsync(`python3 -c '${script}'`);
        }
    }
    /**
     * Click at coordinates
     */
    async click(x, y, button = 'left') {
        if (this.robotjs) {
            this.robotjs.moveMouse(x, y);
            await this.delay(10);
            this.robotjs.mouseClick(button);
            return;
        }
        // AppleScript/cliclick fallback
        try {
            const clickType = button === 'right' ? 'rc' : 'c';
            await execAsync(`cliclick ${clickType}:${x},${y} 2>/dev/null`);
        }
        catch {
            // Python fallback
            const buttonCode = button === 'right' ? 'kCGMouseButtonRight' : 'kCGMouseButtonLeft';
            const eventDown = button === 'right' ? 'kCGEventRightMouseDown' : 'kCGEventLeftMouseDown';
            const eventUp = button === 'right' ? 'kCGEventRightMouseUp' : 'kCGEventLeftMouseUp';
            const script = `
import Quartz
import time
pos = (${x}, ${y})
event = Quartz.CGEventCreateMouseEvent(None, Quartz.${eventDown}, pos, Quartz.${buttonCode})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
time.sleep(0.05)
event = Quartz.CGEventCreateMouseEvent(None, Quartz.${eventUp}, pos, Quartz.${buttonCode})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
`;
            await execAsync(`python3 -c '${script}'`);
        }
    }
    /**
     * Double click at coordinates
     */
    async doubleClick(x, y) {
        if (this.robotjs) {
            this.robotjs.moveMouse(x, y);
            await this.delay(10);
            this.robotjs.mouseClick('left', true); // double = true
            return;
        }
        // Fallback
        try {
            await execAsync(`cliclick dc:${x},${y} 2>/dev/null`);
        }
        catch {
            await this.click(x, y);
            await this.delay(50);
            await this.click(x, y);
        }
    }
    /**
     * Triple click at coordinates
     */
    async tripleClick(x, y) {
        await this.click(x, y);
        await this.delay(50);
        await this.click(x, y);
        await this.delay(50);
        await this.click(x, y);
    }
    /**
     * Drag from start to end coordinates
     */
    async drag(startX, startY, endX, endY) {
        if (this.robotjs) {
            this.robotjs.moveMouse(startX, startY);
            await this.delay(50);
            this.robotjs.mouseToggle('down');
            await this.delay(50);
            // Move in steps for smoother drag
            const steps = 10;
            for (let i = 1; i <= steps; i++) {
                const x = startX + ((endX - startX) * i) / steps;
                const y = startY + ((endY - startY) * i) / steps;
                this.robotjs.moveMouse(x, y);
                await this.delay(20);
            }
            this.robotjs.mouseToggle('up');
            return;
        }
        // Fallback
        try {
            await execAsync(`cliclick dd:${startX},${startY} du:${endX},${endY} 2>/dev/null`);
        }
        catch {
            // Python fallback
            const script = `
import Quartz
import time
start = (${startX}, ${startY})
end = (${endX}, ${endY})
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, start, Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
time.sleep(0.05)
steps = 10
for i in range(1, steps + 1):
    x = start[0] + (end[0] - start[0]) * i / steps
    y = start[1] + (end[1] - start[1]) * i / steps
    event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDragged, (x, y), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    time.sleep(0.02)
event = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, end, Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
`;
            await execAsync(`python3 -c '${script}'`);
        }
    }
    /**
     * Type text
     */
    async typeText(text, delay = 0) {
        if (this.robotjs) {
            if (delay > 0) {
                for (const char of text) {
                    this.robotjs.typeString(char);
                    await this.delay(delay);
                }
            }
            else {
                this.robotjs.typeString(text);
            }
            return;
        }
        // AppleScript fallback - escape special characters
        const escapedText = text
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');
        try {
            await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escapedText}"'`);
        }
        catch (error) {
            throw new Error(`Failed to type text: ${error}`);
        }
    }
    /**
     * Press a key or key combination
     */
    async pressKey(key, modifiers = []) {
        const normalizedKey = KEY_MAP[key.toLowerCase()] || key;
        const normalizedModifiers = modifiers.map(m => KEY_MAP[m.toLowerCase()] || m);
        if (this.robotjs) {
            // robotjs uses different key names
            const robotKey = normalizedKey.toLowerCase();
            const robotModifiers = normalizedModifiers.map(m => {
                if (m === 'command')
                    return 'command';
                if (m === 'control')
                    return 'control';
                if (m === 'option')
                    return 'alt';
                return m;
            });
            this.robotjs.keyTap(robotKey, robotModifiers);
            return;
        }
        // AppleScript fallback
        let script = 'tell application "System Events" to ';
        if (normalizedModifiers.length > 0) {
            const modString = normalizedModifiers.map(m => `${m} down`).join(', ');
            script += `key code (key code of "${normalizedKey}") using {${modString}}`;
        }
        else {
            // Check if it's a special key
            if (normalizedKey.length === 1) {
                script += `keystroke "${normalizedKey}"`;
            }
            else {
                // Key code for special keys
                const keyCodes = {
                    'Return': 36, 'Tab': 48, 'Escape': 53, 'Delete': 51,
                    'ForwardDelete': 117, 'Up': 126, 'Down': 125, 'Left': 123, 'Right': 124,
                    'Home': 115, 'End': 119, 'PageUp': 116, 'PageDown': 121,
                    'F1': 122, 'F2': 120, 'F3': 99, 'F4': 118, 'F5': 96, 'F6': 97,
                    'F7': 98, 'F8': 100, 'F9': 101, 'F10': 109, 'F11': 103, 'F12': 111,
                    'space': 49,
                };
                const code = keyCodes[normalizedKey];
                if (code !== undefined) {
                    script += `key code ${code}`;
                }
                else {
                    script += `keystroke "${normalizedKey}"`;
                }
            }
        }
        try {
            await execAsync(`osascript -e '${script}'`);
        }
        catch (error) {
            throw new Error(`Failed to press key: ${error}`);
        }
    }
    /**
     * Scroll in a direction
     */
    async scroll(direction, amount = 3) {
        if (this.robotjs) {
            let x = 0, y = 0;
            switch (direction) {
                case 'up':
                    y = amount;
                    break;
                case 'down':
                    y = -amount;
                    break;
                case 'left':
                    x = amount;
                    break;
                case 'right':
                    x = -amount;
                    break;
            }
            this.robotjs.scrollMouse(x, y);
            return;
        }
        // AppleScript/cliclick fallback
        try {
            const pos = await this.getCursorPosition();
            let scrollArg;
            switch (direction) {
                case 'up':
                    scrollArg = `su:${amount}`;
                    break;
                case 'down':
                    scrollArg = `sd:${amount}`;
                    break;
                case 'left':
                    scrollArg = `sl:${amount}`;
                    break;
                case 'right':
                    scrollArg = `sr:${amount}`;
                    break;
            }
            await execAsync(`cliclick ${scrollArg} 2>/dev/null`);
        }
        catch {
            // Python fallback
            let dx = 0, dy = 0;
            const scrollUnits = amount * 10; // Convert to pixels
            switch (direction) {
                case 'up':
                    dy = scrollUnits;
                    break;
                case 'down':
                    dy = -scrollUnits;
                    break;
                case 'left':
                    dx = scrollUnits;
                    break;
                case 'right':
                    dx = -scrollUnits;
                    break;
            }
            const script = `
import Quartz
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitPixel, 2, ${dy}, ${dx})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
`;
            await execAsync(`python3 -c '${script}'`);
        }
    }
    /**
     * Execute a computer action
     */
    async executeAction(action) {
        const startTime = Date.now();
        try {
            switch (action.type) {
                case 'screenshot': {
                    const screenshot = await this.screenshot();
                    return {
                        success: true,
                        action: 'screenshot',
                        timestamp: new Date(),
                        screenshot,
                    };
                }
                case 'cursor_position': {
                    const pos = await this.getCursorPosition();
                    return {
                        success: true,
                        action: 'cursor_position',
                        timestamp: new Date(),
                        cursorPosition: pos,
                    };
                }
                case 'mouse_move': {
                    if (!action.coordinate) {
                        throw new Error('mouse_move requires coordinate');
                    }
                    await this.moveMouse(action.coordinate[0], action.coordinate[1]);
                    return {
                        success: true,
                        action: `mouse_move(${action.coordinate[0]}, ${action.coordinate[1]})`,
                        timestamp: new Date(),
                    };
                }
                case 'left_click': {
                    if (action.coordinate) {
                        await this.click(action.coordinate[0], action.coordinate[1], 'left');
                        return {
                            success: true,
                            action: `left_click(${action.coordinate[0]}, ${action.coordinate[1]})`,
                            timestamp: new Date(),
                        };
                    }
                    else {
                        // Click at current position
                        const pos = await this.getCursorPosition();
                        await this.click(pos.x, pos.y, 'left');
                        return {
                            success: true,
                            action: `left_click(${pos.x}, ${pos.y})`,
                            timestamp: new Date(),
                        };
                    }
                }
                case 'right_click': {
                    if (action.coordinate) {
                        await this.click(action.coordinate[0], action.coordinate[1], 'right');
                        return {
                            success: true,
                            action: `right_click(${action.coordinate[0]}, ${action.coordinate[1]})`,
                            timestamp: new Date(),
                        };
                    }
                    else {
                        const pos = await this.getCursorPosition();
                        await this.click(pos.x, pos.y, 'right');
                        return {
                            success: true,
                            action: `right_click(${pos.x}, ${pos.y})`,
                            timestamp: new Date(),
                        };
                    }
                }
                case 'double_click': {
                    if (!action.coordinate) {
                        throw new Error('double_click requires coordinate');
                    }
                    await this.doubleClick(action.coordinate[0], action.coordinate[1]);
                    return {
                        success: true,
                        action: `double_click(${action.coordinate[0]}, ${action.coordinate[1]})`,
                        timestamp: new Date(),
                    };
                }
                case 'triple_click': {
                    if (!action.coordinate) {
                        throw new Error('triple_click requires coordinate');
                    }
                    await this.tripleClick(action.coordinate[0], action.coordinate[1]);
                    return {
                        success: true,
                        action: `triple_click(${action.coordinate[0]}, ${action.coordinate[1]})`,
                        timestamp: new Date(),
                    };
                }
                case 'left_click_drag': {
                    if (!action.startCoordinate || !action.coordinate) {
                        throw new Error('left_click_drag requires startCoordinate and coordinate');
                    }
                    await this.drag(action.startCoordinate[0], action.startCoordinate[1], action.coordinate[0], action.coordinate[1]);
                    return {
                        success: true,
                        action: `drag(${action.startCoordinate[0]},${action.startCoordinate[1]} -> ${action.coordinate[0]},${action.coordinate[1]})`,
                        timestamp: new Date(),
                    };
                }
                case 'type': {
                    if (!action.text) {
                        throw new Error('type requires text');
                    }
                    await this.typeText(action.text);
                    return {
                        success: true,
                        action: `type("${action.text.slice(0, 30)}${action.text.length > 30 ? '...' : ''}")`,
                        timestamp: new Date(),
                    };
                }
                case 'key': {
                    if (!action.text) {
                        throw new Error('key requires text (key name)');
                    }
                    await this.pressKey(action.text, action.modifiers || []);
                    const modStr = action.modifiers?.length ? `[${action.modifiers.join('+')}]+` : '';
                    return {
                        success: true,
                        action: `key(${modStr}${action.text})`,
                        timestamp: new Date(),
                    };
                }
                case 'scroll': {
                    const direction = action.scrollDirection || 'down';
                    const amount = action.scrollAmount || 3;
                    await this.scroll(direction, amount);
                    return {
                        success: true,
                        action: `scroll(${direction}, ${amount})`,
                        timestamp: new Date(),
                    };
                }
                default:
                    throw new Error(`Unknown action type: ${action.type}`);
            }
        }
        catch (error) {
            return {
                success: false,
                action: action.type,
                timestamp: new Date(),
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /**
     * Cleanup temporary files
     */
    cleanup() {
        try {
            const files = fs.readdirSync(this.tempDir);
            for (const file of files) {
                if (file.startsWith('screenshot_')) {
                    fs.unlinkSync(path.join(this.tempDir, file));
                }
            }
        }
        catch {
            // Ignore cleanup errors
        }
    }
    /**
     * Helper: delay for ms milliseconds
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /**
     * Helper: log message if debug enabled
     */
    log(message) {
        if (this.config.debug) {
            console.error(`[LocalComputerController] ${message}`);
        }
    }
}
export default LocalComputerController;
//# sourceMappingURL=controller.js.map