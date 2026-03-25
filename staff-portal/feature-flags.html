import React from 'react';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { functions } from '@/api/railwayClient';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, Clock, MapPin, ArrowRight, Ticket } from 'lucide-react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function Events() {
    const { data: events = [], isLoading, error } = useQuery({
        queryKey: ['events'],
        queryFn: async () => {
            try {
                const result = await functions.invoke('getEventsFromRailway');
                console.log('Events fetched:', result);
                return result.data || [];
            } catch (error) {
                console.error('Failed to fetch events:', error);
                return [];
            }
        },
        retry: 1,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false
    });

    return (
        <div className="min-h-screen bg-stone-950 pt-24 pb-20 px-6">
            <div className="max-w-7xl mx-auto">
                <div className="text-center mb-16">
                    <motion.span
                        className="inline-block text-green-500 text-sm font-semibold tracking-wider uppercase mb-4"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                    >
                        Plan Your Visit
                    </motion.span>
                    <motion.h1
                        className="text-4xl md:text-6xl font-bold text-white mb-4"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                    >
                        Upcoming Events
                    </motion.h1>
                    <motion.p
                        className="text-stone-400 max-w-2xl mx-auto text-lg"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.2 }}
                    >
                        Choose your event and secure your seats for an unforgettable rodeo experience
                    </motion.p>
                </div>

                {isLoading ? (
                    <div className="grid gap-6">
                        {[1, 2, 3].map((i) => (
                            <Card key={i} className="bg-stone-900 border-stone-800 p-6">
                                <div className="flex flex-col md:flex-row gap-6">
                                    <Skeleton className="w-full md:w-64 h-48 rounded-xl" />
                                    <div className="flex-1 space-y-4">
                                        <Skeleton className="h-8 w-3/4" />
                                        <Skeleton className="h-4 w-1/2" />
                                        <Skeleton className="h-4 w-1/3" />
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                ) : events.length === 0 ? (
                    <Card className="bg-stone-900 border-stone-800 p-12 text-center">
                        <Ticket className="w-16 h-16 text-stone-600 mx-auto mb-4" />
                        <h3 className="text-xl font-semibold text-white mb-2">No Events Scheduled</h3>
                        <p className="text-stone-400">Check back soon for upcoming rodeo events!</p>
                    </Card>
                ) : (
                    <div className="grid gap-6">
                        {events.map((event, index) => (
                            <motion.div
                                key={event.id}
                                initial={{ opacity: 0, y: 30 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: index * 0.1 }}
                            >
                                <Card className="bg-stone-900 border-stone-800 overflow-hidden group hover:border-green-500/30 transition-all duration-300">
                                    <div className="flex flex-col lg:flex-row">
                                        <div className="relative lg:w-80 h-56 lg:h-auto overflow-hidden">
                                            <img
                                                src={event.image_url || 'https://images.unsplash.com/photo-1570042225831-d98fa7577f1e?w=600&q=80'}
                                                alt={event.title}
                                                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                                            />
                                            {event.is_featured && (
                                                <Badge className="absolute top-4 left-4 bg-green-500 text-stone-900 font-semibold">
                                                    Featured Event
                                                </Badge>
                                            )}
                                        </div>

                                        <div className="flex-1 p-6 lg:p-8">
                                            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
                                                <div className="flex-1">
                                                    <h3 className="text-2xl font-bold text-white mb-4 group-hover:text-green-400 transition-colors">
                                                        {event.title}
                                                    </h3>

                                                    {event.description && (
                                                        <p className="text-stone-400 mb-4 line-clamp-2">
                                                            {event.description}
                                                        </p>
                                                    )}

                                                    <div className="flex flex-wrap gap-4 text-sm">
                                                        <div className="flex items-center gap-2 text-stone-300">
                                                            <Calendar className="w-4 h-4 text-green-500" />
                                                            <span>{format(new Date(event.date.replace('T00:00:00.000Z', 'T12:00:00.000Z')), 'EEEE, MMMM d, yyyy')}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-stone-300">
                                                            <Clock className="w-4 h-4 text-green-500" />
                                                            <span>{event.time}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-stone-300">
                                                            <MapPin className="w-4 h-4 text-green-500" />
                                                            <span>{event.venue || 'Main Arena'}</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="lg:text-right">
                                                    <div className="mb-4">
                                                        <span className="text-stone-500 text-sm block mb-1">{event.id === '696b7bdc81676e7ff80617a1' ? 'Entry Fee' : 'Starting at'}</span>
                                                        <span className="text-3xl font-bold text-green-400">
                                                            ${event.id === '696b7bdc81676e7ff80617a1' ? '0' : (event.general_price || 30)}
                                                        </span>
                                                    </div>

                                                    <div className="flex flex-wrap gap-2 lg:justify-end mb-4">
                                                        {event.general_available > 0 && (
                                                            <Badge variant="outline" className="border-green-500/50 text-green-400">
                                                                General Available
                                                            </Badge>
                                                        )}
                                                        {event.premium_available > 0 && (
                                                            <Badge variant="outline" className="border-blue-500/50 text-blue-400">
                                                                Premium Available
                                                            </Badge>
                                                        )}
                                                        {event.vip_available > 0 && (
                                                            <Badge variant="outline" className="border-green-500/50 text-green-400">
                                                                VIP Available
                                                            </Badge>
                                                        )}
                                                    </div>

                                                    {event.id !== '696b7bdc81676e7ff80617a1' && (
                                                        <Link to={`${createPageUrl('BuyTickets')}?eventId=${event.id}`}>
                                                            <Button className="bg-green-500 hover:bg-green-600 text-stone-900 font-semibold w-full lg:w-auto group/btn">
                                                                Buy Tickets
                                                                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover/btn:translate-x-1" />
                                                            </Button>
                                                        </Link>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </Card>
                            </motion.div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
