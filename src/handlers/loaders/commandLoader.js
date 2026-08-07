import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

function getSubcommandInfo(commandData) {
    const subcommands = [];
    
    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) {
                subcommands.push(option.name);
            } else if (option.type === 2) {
                if (option.options) {
                    for (const subOption of option.options) {
                        if (subOption.type === 1) {
                            subcommands.push(`${option.name}/${subOption.name}`);
                        }
                    }
                }
            }
        }
    }
    
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        
        if (file.isDirectory()) {
            if (file.name === 'modules') continue;
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    
    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');

    const ALLOWED_CATEGORIES = [
        'Core',
        'Verification',
        'Moderation',
        'Reaction_roles',
        'Roles',
        'valorant',
        'Welcome',
    ];

    const commandFiles = [];
    for (const category of ALLOWED_CATEGORIES) {
        const categoryPath = path.join(commandsPath, category);
        try {
            const files = await getAllFiles(categoryPath);
            commandFiles.push(...files);
        } catch (err) {
            logger.debug(`Category folder not found (skipping): ${category}`);
        }
    }

    logger.info(`Found ${commandFiles.length} command files to load (whitelisted categories only)`);

    const uniqueCommandNames = new Set();

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);

            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;

            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;

            const primaryCommandName = command.data.name;

            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                client.commands.set(primaryCommandName, command);
            }

            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }

    logger.info(`Loaded ${client.commands.size} commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') continue;

        const commandName = command.data.name;
        if (registeredNames.has(commandName)) continue;

        registeredNames.add(commandName);
        const commandJson = command.data.toJSON();
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;
    }

    return { commands, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) {
            validationErrors.push(`Command ${cmd.name} has name longer than 32 chars`);
        }
        if (cmd.description && cmd.description.length > 110) {
            validationErrors.push(`Command ${cmd.name} has description longer than 110 chars`);
        }
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed:');
        validationErrors.forEach(e => logger.error(`  - ${e}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length > MAX_COMMANDS) {
        logger.warn(`Command count exceeds Discord limit, truncating...`);
        return commands.slice(0, MAX_COMMANDS);
    }
    return commands;
}

async function registerGlobalCommands(client, clientId, commands, totalSubcommands) {
    if (!clientId) throw new Error('CLIENT_ID is required');
    if (!client.rest) throw new Error('Discord REST client is not available');

    logger.info(`Preparing to register ${commands.length} commands globally`);
    validateCommands(commands);

    const commandsToRegister = prepareCommandsForRegistration(commands);

    if (botConfig.commands?.deleteCommands) {
        await client.rest.put(`/applications/${clientId}/commands`, { body: [] });
    }

    await client.rest.put(`/applications/${clientId}/commands`, { body: commandsToRegister });
    logger.info(`Successfully registered ${commandsToRegister.length} global commands`);
}

export async function registerCommands(client, options = {}) {
    const { clientId = null } = options;
    try {
        const { commands, totalSubcommands } = collectCommandPayloads(client);
        await registerGlobalCommands(client, clientId, commands, totalSubcommands);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    if (!command) return { success: false, message: `Command "${commandName}" not found` };

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());

        const newCommand = (await import(moduleUrl.href)).default;
        client.commands.set(commandName, newCommand);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}
