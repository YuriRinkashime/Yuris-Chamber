import { MessageFlags } from 'discord.js';
import { getThread, saveThread, upsertOwnerNotify } from '../../../services/dmInboxService.js';

export default {
  name: 'dm_page',
  async execute(interaction, client, args = []) {
    const userId = args[0];
    const dir = args[1]; // prev | next | latest
    if (!userId) {
      return interaction.reply({ content: 'Missing user.', flags: MessageFlags.Ephemeral });
    }
    const thread = await getThread(client, userId);
    const PAGE = 8;
    const totalPages = Math.max(1, Math.ceil((thread.messages || []).length / PAGE));
    let page = Number(thread.cardPage ?? totalPages - 1);
    if (dir === 'prev') page = Math.max(0, page - 1);
    else if (dir === 'next') page = Math.min(totalPages - 1, page + 1);
    else if (dir === 'latest') page = totalPages - 1;
    thread.cardPage = page;
    await saveThread(client, thread);
    await upsertOwnerNotify(client, userId, {});
    return interaction.deferUpdate().catch(() =>
      interaction.reply({ content: `Page ${page + 1}/${totalPages}`, flags: MessageFlags.Ephemeral }),
    );
  },
};
